/**
 * Criação de imagens.
 *   GET  /api/capabilities                      → o que esta instalação consegue fazer
 *   POST /api/conversations/:id/images          → gera uma imagem a partir de um texto
 *
 * A geração pode demorar minutos (CPU), por isso o pedido fica aberto até ao fim. Só se grava algo
 * (mensagem do utilizador, mensagem do assistente e o ficheiro) DEPOIS de a imagem estar gerada e
 * verificada: uma falha não deixa mensagens a meio. Se o cliente desistir, a geração é cancelada.
 * Há no máximo `maxConcurrent` gerações em simultâneo (por defeito 1): um modelo de imagem em CPU
 * ocupa a máquina toda.
 */
import { createHash, randomUUID } from 'node:crypto';
import { LIMITS, createImageSchema, type Capabilities } from '../../shared/contract.ts';
import { deriveTitle } from '../../shared/text.ts';
import type { Db } from '../db/db.ts';
import { PgError } from '../db/db.ts';
import { HttpError, readJson, sendJson, uuidParam, type Router } from '../http/http.ts';
import { ImageError, type ImageGenerator } from '../providers/images.ts';
import { createRateLimiter } from '../rate-limit.ts';
import type { ObjectStorage } from '../storage/storage.ts';
import { audit } from './audit.ts';
import type { AuthUser } from './auth.ts';
import { getOwnedConversation } from './conversations.ts';

export interface ImagesOptions {
  log: (l: string) => void;
  maxConcurrent?: number;
  perMinute?: number;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export function registerImages(router: Router<AuthUser | null>, db: Db, storage: ObjectStorage, generator: ImageGenerator | null, options: ImagesOptions) {
  const { log } = options;
  const maxConcurrent = options.maxConcurrent ?? 1;
  const perMinute = options.perMinute ?? 6;
  const limiter = createRateLimiter(perMinute, perMinute / 60);
  const running = new Set<string>(); // utilizadores com geração em curso
  const controllers = new Set<AbortController>();

  router.add(
    'GET',
    '/api/capabilities',
    ({ res }) => {
      const caps: Capabilities = { images: generator ? { available: true, label: generator.label, size: generator.size } : { available: false } };
      sendJson(res, 200, caps);
    },
    { auth: true },
  );

  router.add(
    'POST',
    '/api/conversations/:id/images',
    async ({ req, res, params, user, ip }) => {
      const u = user!;
      if (!generator) throw new HttpError(501, 'images_not_configured', 'A criação de imagens não está configurada neste servidor.');
      const conversationId = uuidParam(params.id);
      if (!limiter.take(u.id)) throw new HttpError(429, 'rate_limited', 'Demasiados pedidos de imagem. Tenta dentro de momentos.', { 'Retry-After': '30' });
      const body = await readJson(req, createImageSchema, LIMITS.jsonBodyBytes);
      if (!(await getOwnedConversation(db, u.id, conversationId))) throw new HttpError(404, 'not_found', 'Conversa não encontrada.');
      if (running.has(u.id) || running.size >= maxConcurrent) {
        throw new HttpError(429, 'image_busy', 'Já há uma imagem a ser criada. Espera que termine.', { 'Retry-After': '30' });
      }

      const controller = new AbortController();
      controllers.add(controller);
      running.add(u.id);
      // Se o cliente desistir (fechar a página, cancelar), pára-se a geração.
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);
      let blobKey: string | null = null;
      try {
        const started = Date.now();
        const image = await generator.generate(body.prompt, controller.signal);
        log(`[imagens] ${u.id.slice(0, 8)} ${image.data.length} B em ${Math.round((Date.now() - started) / 1000)} s`);

        const used = await db.query<{ total: number }>('SELECT COALESCE(SUM(size_bytes), 0)::int8 AS total FROM files WHERE user_id = $1', [u.id]);
        if ((used.rows[0]?.total ?? 0) + image.data.length > LIMITS.userStorageBytes) {
          throw new HttpError(413, 'quota_exceeded', 'Atingiste o limite de armazenamento da conta.');
        }
        const fileId = randomUUID();
        blobKey = randomUUID();
        await storage.put(blobKey, image.data);
        const name = `imagem-${fileId.slice(0, 8)}.${EXT[image.mediaType] ?? 'png'}`;
        try {
          await db.tx(async (q) => {
            const c = await getOwnedConversation(q, u.id, conversationId, true);
            if (!c) throw new HttpError(404, 'not_found', 'A conversa foi apagada durante a criação da imagem.');
            const count = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [conversationId]);
            await q.query(`INSERT INTO messages (id, conversation_id, user_id, role, content, status) VALUES ($1, $2, $3, 'user', $4, 'complete')`, [
              body.userMessageId,
              conversationId,
              u.id,
              body.prompt,
            ]);
            await q.query(
              `INSERT INTO messages (id, conversation_id, user_id, role, content, status, model) VALUES ($1, $2, $3, 'assistant', $4, 'complete', $5)`,
              [body.assistantMessageId, conversationId, u.id, `[Imagem criada a partir do pedido: ${body.prompt.slice(0, 200)}]`, `imagem:${generator.model}`.slice(0, 64)],
            );
            await q.query(
              `INSERT INTO files (id, user_id, message_id, name, media_type, kind, size_bytes, sha256, storage_key)
               VALUES ($1, $2, $3, $4, $5, 'image', $6, $7, $8)`,
              [fileId, u.id, body.assistantMessageId, name, image.mediaType, image.data.length, createHash('sha256').update(image.data).digest(), blobKey],
            );
            const title = count.rows[0]!.n === 0 && c.title === 'Nova conversa' ? deriveTitle(body.prompt) : null;
            await q.query('UPDATE conversations SET updated_at = now(), title = COALESCE($2, title) WHERE id = $1', [conversationId, title]);
          });
        } catch (e) {
          await storage.delete(blobKey).catch(() => undefined);
          blobKey = null;
          if (e instanceof PgError && /duplicate|unique/i.test(e.message)) throw new HttpError(409, 'duplicate_message', 'Esta mensagem já existe.');
          throw e;
        }
        await audit(db, { userId: u.id, action: 'image.generate', target: fileId, ip, metadata: { size: image.data.length, ms: Date.now() - started } });
        sendJson(res, 201, { userMessageId: body.userMessageId, assistantMessageId: body.assistantMessageId, fileId });
      } catch (e) {
        if (e instanceof ImageError) {
          if (e.code === 'cancelled') return; // o cliente já não está lá
          throw new HttpError(e.status, e.code, e.message);
        }
        throw e;
      } finally {
        res.off('close', onClose);
        controllers.delete(controller);
        running.delete(u.id);
      }
    },
    { auth: true },
  );

  return {
    /** Cancela as gerações em curso (encerramento do servidor). */
    shutdown() {
      for (const c of controllers) c.abort();
    },
  };
}
