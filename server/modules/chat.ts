/**
 * POST /api/conversations/:id/messages — envia (ou regenera) e transmite a resposta por SSE.
 *
 * O servidor é a fonte de verdade: o histórico enviado ao modelo é lido da base
 * de dados, nunca aceite do cliente. A resposta é gravada durante o streaming
 * (a cada 1,5 s) e no fim, incluindo quando o cliente cancela ou cai.
 * Um índice único parcial garante no máximo uma geração em curso por conversa.
 */
import type { ServerResponse } from 'node:http';
import {
  LIMITS,
  sendMessageSchema,
  type ChatMessage,
  type FinishReason,
  type MessageErrorInfo,
  type StreamEvent,
  type Usage,
} from '../../shared/contract.ts';
import { deriveTitle } from '../../shared/text.ts';
import { estimateTokens, trimHistory } from '../context.ts';
import { buildSystemPrompt } from '../prompts/system.ts';
import { PgError, type Db } from '../db/db.ts';
import { HttpError, readJson, uuidParam, type Router } from '../http/http.ts';
import type { ModelProvider } from '../providers/types.ts';
import { createRateLimiter } from '../rate-limit.ts';
import { formatSse } from '../sse.ts';
import type { ObjectStorage } from '../storage/storage.ts';
import type { AuthUser } from './auth.ts';
import { getOwnedConversation, loadMessages, uuidArray } from './conversations.ts';

const FLUSH_MS = 1500;

export interface ChatOptions {
  /** Teto do orçamento de contexto; o limite efetivo depende do modelo. */
  contextBudgetTokens?: number;
  chatPerMinute?: number;
  log: (l: string) => void;
}

export function registerChat(
  router: Router<AuthUser | null>,
  db: Db,
  provider: ModelProvider,
  storage: ObjectStorage,
  options: ChatOptions,
) {
  const { log } = options;
  const budgetCap = options.contextBudgetTokens ?? 128_000;
  const perMinute = options.chatPerMinute ?? 30;
  const limiter = createRateLimiter(perMinute, perMinute / 60);
  const active = new Map<AbortController, Promise<void>>();

  /** Histórico para o modelo, com o texto dos anexos lido do armazenamento. */
  async function buildHistory(userId: string, conversationId: string, exclude: string, budget: number): Promise<ChatMessage[]> {
    const messages = await loadMessages(db, userId, conversationId);
    const out: ChatMessage[] = [];
    for (const m of messages) {
      if (m.id === exclude) continue;
      if (m.role === 'assistant' && (m.status === 'error' || m.content.length === 0)) continue;
      const attachments: NonNullable<ChatMessage['attachments']> = [];
      for (const f of m.files) {
        if (f.kind === 'text') {
          const row = await db.query<{ storage_key: string }>('SELECT storage_key FROM files WHERE id = $1 AND user_id = $2', [f.id, userId]);
          const text = row.rows[0] ? (await storage.get(row.rows[0].storage_key)).toString('utf8') : '';
          const cut = text.length > LIMITS.attachmentContextChars;
          attachments.push({
            name: f.name,
            mediaType: f.mediaType,
            size: f.size,
            content: cut ? `${text.slice(0, LIMITS.attachmentContextChars)}\n[… truncado]` : text,
          });
        } else {
          // Imagens e PDF só serão interpretados com um modelo multimodal (Fase 4).
          attachments.push({ name: f.name, mediaType: f.mediaType, size: f.size, content: '' });
        }
      }
      out.push({ role: m.role, content: m.content, ...(attachments.length ? { attachments } : {}) });
    }
    return trimHistory(out, budget);
  }

  router.add(
    'POST',
    '/api/conversations/:id/messages',
    async ({ req, res, params, user }) => {
      const u = user!;
      const conversationId = uuidParam(params.id);
      if (!limiter.take(u.id)) {
        throw new HttpError(429, 'rate_limited', 'Demasiados pedidos. Tenta dentro de momentos.', { 'Retry-After': '10' });
      }
      const body = await readJson(req, sendMessageSchema, LIMITS.jsonBodyBytes);
      const model = provider.models.find((m) => m.id === body.model);
      if (!model) throw new HttpError(422, 'unknown_model', 'Modelo desconhecido.');
      if (model.status === 'offline') {
        // O estado pode estar desatualizado: verificar de novo antes de recusar.
        await provider.refresh?.();
        const fresh = provider.models.find((m) => m.id === body.model);
        if (fresh?.status === 'offline') {
          throw new HttpError(409, 'model_unavailable', `${model.label} está indisponível: ${fresh.statusDetail ?? 'servidor de modelos inacessível.'}`);
        }
      }
      if (body.mode === 'send' && !body.userMessage.content.trim() && body.userMessage.fileIds.length === 0) {
        throw new HttpError(422, 'empty_message', 'Mensagem vazia.');
      }
      const assistantId = body.assistantMessageId;

      try {
        await db.tx(async (q) => {
          const c = await getOwnedConversation(q, u.id, conversationId, true);
          if (!c) throw new HttpError(404, 'not_found', 'Conversa não encontrada.');
          let title: string | null = null;

          if (body.mode === 'send') {
            const { id, content, fileIds } = body.userMessage;
            const unique = [...new Set(fileIds.map((f) => f.toLowerCase()))];
            if (unique.length) {
              const owned = await q.query(
                'SELECT id FROM files WHERE user_id = $1 AND id = ANY($2::uuid[]) AND message_id IS NULL',
                [u.id, uuidArray(unique)],
              );
              if (owned.rows.length !== unique.length) {
                throw new HttpError(422, 'invalid_files', 'Um ou mais anexos não existem ou já foram usados.');
              }
            }
            const count = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [conversationId]);
            if (count.rows[0]!.n === 0 && c.title === 'Nova conversa') {
              let firstName: string | undefined;
              if (unique.length) {
                const f = await q.query<{ name: string }>('SELECT name FROM files WHERE id = $1', [unique[0]!]);
                firstName = f.rows[0]?.name;
              }
              title = deriveTitle(content || firstName || '');
            }
            await q.query(
              `INSERT INTO messages (id, conversation_id, user_id, role, content, status) VALUES ($1, $2, $3, 'user', $4, 'complete')`,
              [id, conversationId, u.id, content],
            );
            if (unique.length) {
              await q.query('UPDATE files SET message_id = $1 WHERE user_id = $2 AND id = ANY($3::uuid[])', [id, u.id, uuidArray(unique)]);
            }
          } else {
            const last = await q.query<{ id: string; role: string; status: string }>(
              'SELECT id, role, status FROM messages WHERE conversation_id = $1 ORDER BY seq DESC LIMIT 1',
              [conversationId],
            );
            const row = last.rows[0];
            if (!row || row.id !== body.fromMessageId.toLowerCase() || row.role !== 'assistant') {
              throw new HttpError(409, 'not_last_message', 'Só é possível regenerar a última resposta.');
            }
            if (row.status === 'streaming') throw new HttpError(409, 'generation_in_progress', 'Já existe uma resposta em curso.');
            await q.query('DELETE FROM messages WHERE id = $1 AND user_id = $2', [row.id, u.id]);
          }

          await q.query(
            `INSERT INTO messages (id, conversation_id, user_id, role, content, status, model) VALUES ($1, $2, $3, 'assistant', '', 'streaming', $4)`,
            [assistantId, conversationId, u.id, model.id],
          );
          await q.query(
            'UPDATE conversations SET updated_at = now(), model = $2, title = COALESCE($3, title) WHERE id = $1',
            [conversationId, model.id, title],
          );
        });
      } catch (e) {
        if (e instanceof PgError && e.code === '23505') {
          if (e.constraint === 'messages_one_streaming_idx') {
            throw new HttpError(409, 'generation_in_progress', 'Já existe uma resposta em curso nesta conversa.');
          }
          throw new HttpError(409, 'duplicate_message', 'Mensagem já enviada.');
        }
        throw e;
      }

      // Orçamento: janela do modelo − resposta máxima − prompt de sistema, com margem
      // de 10% porque a contagem é estimada (≈4 caracteres por token).
      const limits = provider.limits?.(model.id) ?? { contextTokens: 32_000, maxOutputTokens: 4_096, toolCalling: 'prompted' as const };
      const system = model.hosting === 'simulated' ? undefined : buildSystemPrompt(model);
      const budget = Math.max(
        1_000,
        Math.min(budgetCap, Math.floor((limits.contextTokens - limits.maxOutputTokens) * 0.9) - estimateTokens(system ?? '')),
      );
      const history = await buildHistory(u.id, conversationId, assistantId, budget);
      const controller = new AbortController();
      const done = stream(res, { assistantId, conversationId, modelId: model.id, history, ...(system ? { system } : {}) }, controller);
      active.set(controller, done);
      try {
        await done;
      } finally {
        active.delete(controller);
      }
    },
    { auth: true },
  );

  async function stream(
    res: ServerResponse,
    job: { assistantId: string; conversationId: string; modelId: string; history: ChatMessage[]; system?: string },
    controller: AbortController,
  ): Promise<void> {
    res.on('close', () => controller.abort());
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: StreamEvent) => {
      if (!res.writableEnded && !res.destroyed) res.write(formatSse(event));
    };
    send({ type: 'message.start', data: { id: job.assistantId, model: job.modelId } });

    let content = '';
    let final: { status: 'complete' | 'cancelled' | 'error'; usage?: Usage; error?: MessageErrorInfo; finishReason?: FinishReason } | null = null;
    let flushing: Promise<unknown> = Promise.resolve();
    const timer = setInterval(() => {
      const snapshot = content;
      flushing = flushing
        .then(() =>
          db.query("UPDATE messages SET content = $2, updated_at = now() WHERE id = $1 AND status = 'streaming'", [job.assistantId, snapshot]),
        )
        .catch((e: Error) => log(`[chat] falha ao gravar parcial: ${e.message}`));
    }, FLUSH_MS);

    const started = Date.now();
    try {
      const request = { model: job.modelId, messages: job.history, ...(job.system ? { system: job.system } : {}) };
      for await (const ev of provider.stream(request, controller.signal)) {
        if (ev.type === 'reasoning' || ev.type === 'tool_call') {
          // Raciocínio interno não é mostrado nem guardado; o chat não oferece ferramentas.
          continue;
        } else if (ev.type === 'delta') {
          content += ev.text;
          send({ type: 'delta', data: { text: ev.text } });
        } else if (ev.type === 'end') {
          final = { status: ev.finishReason === 'cancelled' ? 'cancelled' : 'complete', usage: ev.usage, finishReason: ev.finishReason };
        } else {
          final = { status: 'error', error: { code: ev.code, message: ev.message, retryable: ev.retryable } };
        }
      }
    } catch (e) {
      log(`[chat] fornecedor falhou: ${(e as Error).message}`);
      final = { status: 'error', error: { code: 'provider_error', message: 'O fornecedor falhou.', retryable: true } };
    } finally {
      clearInterval(timer);
    }
    final ??= controller.signal.aborted ? { status: 'cancelled', finishReason: 'cancelled' } : { status: 'complete', finishReason: 'stop' };

    await flushing;
    try {
      await db.query(
        `UPDATE messages SET content = $2, status = $3, usage = $4, error = $5, updated_at = now() WHERE id = $1`,
        [job.assistantId, content, final.status, final.usage ?? null, final.error ?? null],
      );
      await db.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [job.conversationId]);
    } catch (e) {
      log(`[chat] falha ao gravar resposta ${job.assistantId}: ${(e as Error).message}`);
      final = { status: 'error', error: { code: 'persist_failed', message: 'Não foi possível gravar a resposta.', retryable: true } };
    }

    if (final.status === 'error') send({ type: 'error', data: final.error! });
    else {
      send({
        type: 'message.end',
        data: {
          finishReason: final.finishReason ?? (final.status === 'cancelled' ? 'cancelled' : 'stop'),
          usage: final.usage ?? { inputTokens: 0, outputTokens: 0, estimated: true },
        },
      });
    }
    log(`[chat] ${job.assistantId} ${job.modelId} ${final.status} ${Date.now() - started}ms`);
    res.end();
  }

  /** Cancela gerações em curso e espera que fiquem gravadas (encerramento ordenado). */
  async function shutdown() {
    for (const c of active.keys()) c.abort();
    await Promise.allSettled(active.values());
  }

  return { shutdown };
}
