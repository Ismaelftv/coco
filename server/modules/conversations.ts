/**
 * Conversas: listagem paginada com pesquisa, detalhe com mensagens, alteração e eliminação.
 * Todas as consultas filtram por user_id: um id de outro utilizador comporta-se
 * exatamente como um id inexistente (404), sem revelar que existe.
 */
import {
  LIMITS,
  createConversationSchema,
  updateConversationSchema,
  type ConversationDetail,
  type ConversationSummary,
  type MessageDTO,
} from '../../shared/contract.ts';
import { PgError, type Db, type PgParam, type Queryable } from '../db/db.ts';
import { HttpError, readJson, sendJson, uuidParam, type Router } from '../http/http.ts';
import type { ModelProvider } from '../providers/types.ts';
import type { ObjectStorage } from '../storage/storage.ts';
import { audit } from './audit.ts';
import type { AuthUser } from './auth.ts';
import { deleteBlobs, toFileInfo, type FileRow } from './files.ts';

interface ConversationRow {
  id: string;
  title: string;
  model: string;
  created_at: Date;
  updated_at: Date;
}

export interface MessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageDTO['status'];
  model: string | null;
  error: MessageDTO['error'];
  usage: MessageDTO['usage'];
  created_at: Date;
  seq: number;
}

export const toSummary = (r: ConversationRow): ConversationSummary => ({
  id: r.id,
  title: r.title,
  model: r.model,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** Escapa os curingas de LIKE para que a pesquisa seja literal. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Literal de array do PostgreSQL para ids já validados como UUID. */
export function uuidArray(ids: readonly string[]): string {
  return `{${ids.join(',')}}`;
}

export async function getOwnedConversation(q: Queryable, userId: string, id: string, forUpdate = false) {
  const r = await q.query<ConversationRow>(
    `SELECT id, title, model, created_at, updated_at FROM conversations WHERE id = $1 AND user_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [id, userId],
  );
  return r.rows[0] ?? null;
}

export async function loadMessages(q: Queryable, userId: string, conversationId: string): Promise<MessageDTO[]> {
  const [msgs, files] = await Promise.all([
    q.query<MessageRow>(
      `SELECT id, role, content, status, model, error, usage, created_at, seq
         FROM messages WHERE conversation_id = $1 AND user_id = $2 ORDER BY seq`,
      [conversationId, userId],
    ),
    q.query<FileRow>(
      `SELECT f.id, f.name, f.media_type, f.kind, f.size_bytes, f.storage_key, f.message_id, f.created_at
         FROM files f JOIN messages m ON m.id = f.message_id
        WHERE m.conversation_id = $1 AND f.user_id = $2 ORDER BY f.created_at`,
      [conversationId, userId],
    ),
  ]);
  const byMessage = new Map<string, FileRow[]>();
  for (const f of files.rows) {
    const list = byMessage.get(f.message_id!) ?? [];
    list.push(f);
    byMessage.set(f.message_id!, list);
  }
  return msgs.rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    status: m.status,
    model: m.model,
    error: m.error,
    usage: m.usage,
    files: (byMessage.get(m.id) ?? []).map(toFileInfo),
    createdAt: m.created_at.toISOString(),
  }));
}

export function registerConversations(
  router: Router<AuthUser | null>,
  db: Db,
  provider: ModelProvider,
  storage: ObjectStorage,
  log: (l: string) => void,
) {
  router.add(
    'GET',
    '/api/conversations',
    async ({ res, url, user }) => {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
      const cursor = url.searchParams.get('cursor');
      const params: PgParam[] = [user!.id];
      const where = ['c.user_id = $1'];
      if (q) {
        params.push(likePattern(q.normalize('NFC')));
        const p = `$${params.length}`;
        where.push(`(forja_fold(c.title) LIKE forja_fold(${p}) OR EXISTS (
          SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND forja_fold(m.content) LIKE forja_fold(${p})))`);
      }
      if (cursor) {
        const [at, id] = cursor.split('_');
        const date = new Date(at ?? '');
        if (Number.isNaN(date.getTime()) || !id) throw new HttpError(400, 'invalid_cursor', 'Cursor inválido.');
        params.push(date, uuidParam(id));
        where.push(`(c.updated_at, c.id) < ($${params.length - 1}, $${params.length})`);
      }
      params.push(LIMITS.conversationsPage + 1);
      const r = await db.query<ConversationRow>(
        `SELECT c.id, c.title, c.model, c.created_at, c.updated_at FROM conversations c
          WHERE ${where.join(' AND ')}
          ORDER BY c.updated_at DESC, c.id DESC LIMIT $${params.length}`,
        params,
      );
      const rows = r.rows.slice(0, LIMITS.conversationsPage);
      const last = rows.at(-1);
      const nextCursor =
        r.rows.length > LIMITS.conversationsPage && last ? `${last.updated_at.toISOString()}_${last.id}` : null;
      sendJson(res, 200, { conversations: rows.map(toSummary), nextCursor });
    },
    { auth: true },
  );

  router.add(
    'POST',
    '/api/conversations',
    async ({ req, res, user }) => {
      const body = await readJson(req, createConversationSchema, LIMITS.jsonBodyBytes);
      const model = provider.models.find((m) => m.id === body.model);
      if (!model) throw new HttpError(422, 'unknown_model', 'Modelo desconhecido.');
      try {
        const r = await db.query<ConversationRow>(
          `INSERT INTO conversations (id, user_id, title, model) VALUES ($1, $2, $3, $4)
           RETURNING id, title, model, created_at, updated_at`,
          [body.id, user!.id, body.title ?? 'Nova conversa', body.model],
        );
        sendJson(res, 201, { conversation: toSummary(r.rows[0]!) });
      } catch (e) {
        if (e instanceof PgError && e.code === '23505') {
          // Repetição idempotente do mesmo pedido pelo mesmo utilizador.
          const existing = await getOwnedConversation(db, user!.id, body.id);
          if (existing) return sendJson(res, 200, { conversation: toSummary(existing) });
          throw new HttpError(409, 'id_conflict', 'Identificador já utilizado.');
        }
        throw e;
      }
    },
    { auth: true },
  );

  router.add(
    'GET',
    '/api/conversations/:id',
    async ({ res, params, user }) => {
      const id = uuidParam(params.id);
      const c = await getOwnedConversation(db, user!.id, id);
      if (!c) throw new HttpError(404, 'not_found', 'Conversa não encontrada.');
      const detail: ConversationDetail = { ...toSummary(c), messages: await loadMessages(db, user!.id, id) };
      sendJson(res, 200, { conversation: detail });
    },
    { auth: true },
  );

  router.add(
    'PATCH',
    '/api/conversations/:id',
    async ({ req, res, params, user }) => {
      const id = uuidParam(params.id);
      const body = await readJson(req, updateConversationSchema, LIMITS.jsonBodyBytes);
      if (body.model && !provider.models.some((m) => m.id === body.model)) {
        throw new HttpError(422, 'unknown_model', 'Modelo desconhecido.');
      }
      // Mudar o nome não altera updated_at, para não reordenar o histórico.
      const r = await db.query<ConversationRow>(
        `UPDATE conversations SET title = COALESCE($3, title), model = COALESCE($4, model)
          WHERE id = $1 AND user_id = $2 RETURNING id, title, model, created_at, updated_at`,
        [id, user!.id, body.title ?? null, body.model ?? null],
      );
      if (!r.rows[0]) throw new HttpError(404, 'not_found', 'Conversa não encontrada.');
      sendJson(res, 200, { conversation: toSummary(r.rows[0]) });
    },
    { auth: true },
  );

  router.add(
    'DELETE',
    '/api/conversations/:id',
    async ({ res, params, user, ip }) => {
      const id = uuidParam(params.id);
      const keys = await db.tx(async (q) => {
        const c = await getOwnedConversation(q, user!.id, id, true);
        if (!c) throw new HttpError(404, 'not_found', 'Conversa não encontrada.');
        // Os ficheiros anexados são apagados com a conversa (não ficam órfãos).
        const files = await q.query<{ storage_key: string }>(
          `DELETE FROM files f USING messages m
            WHERE f.message_id = m.id AND m.conversation_id = $1 AND f.user_id = $2
            RETURNING f.storage_key`,
          [id, user!.id],
        );
        await q.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [id, user!.id]);
        await audit(q, { userId: user!.id, action: 'conversation.delete', target: id, ip, metadata: { files: files.rows.length } });
        return files.rows.map((f) => f.storage_key);
      });
      await deleteBlobs(storage, keys, log);
      res.writeHead(204).end();
    },
    { auth: true },
  );
}
