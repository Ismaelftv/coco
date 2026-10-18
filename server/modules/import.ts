/**
 * POST /api/import/local — importação única do histórico que a Fase 2 guardava
 * no navegador. Tudo numa transação: ou entra tudo, ou nada. Os ids antigos
 * são descartados e gerados de novo no servidor.
 */
import { createHash, randomUUID } from 'node:crypto';
import { LIMITS, importSchema } from '../../shared/contract.ts';
import type { Db } from '../db/db.ts';
import { HttpError, readJson, sendJson, type Router } from '../http/http.ts';
import type { ObjectStorage } from '../storage/storage.ts';
import { audit } from './audit.ts';
import type { AuthUser } from './auth.ts';

export function registerImport(router: Router<AuthUser | null>, db: Db, storage: ObjectStorage) {
  router.add(
    'POST',
    '/api/import/local',
    async ({ req, res, user, ip }) => {
      const u = user!;
      const body = await readJson(req, importSchema, LIMITS.importBodyBytes);
      const written: string[] = [];
      let messages = 0;
      let files = 0;

      try {
        await db.tx(async (q) => {
          const used = await q.query<{ total: number }>(
            'SELECT COALESCE(SUM(size_bytes), 0)::int8 AS total FROM files WHERE user_id = $1',
            [u.id],
          );
          let total = used.rows[0]?.total ?? 0;

          for (const c of body.conversations) {
            const conversationId = randomUUID();
            await q.query(
              'INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
              [conversationId, u.id, c.title, c.model, new Date(c.createdAt), new Date(c.updatedAt)],
            );
            for (const m of c.messages) {
              const messageId = randomUUID();
              const status = m.status === 'streaming' ? 'cancelled' : m.status;
              await q.query(
                `INSERT INTO messages (id, conversation_id, user_id, role, content, status, model, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
                [messageId, conversationId, u.id, m.role, m.content, status, m.model ?? null, new Date(m.createdAt)],
              );
              messages++;
              for (const a of m.attachments ?? []) {
                const data = Buffer.from(a.content, 'utf8');
                if (data.length === 0) continue;
                total += data.length;
                if (total > LIMITS.userStorageBytes) {
                  throw new HttpError(413, 'quota_exceeded', 'O histórico excede o limite de armazenamento da conta.');
                }
                const key = randomUUID();
                await storage.put(key, data);
                written.push(key);
                await q.query(
                  `INSERT INTO files (id, user_id, message_id, name, media_type, kind, size_bytes, sha256, storage_key)
                   VALUES ($1, $2, $3, $4, 'text/plain; charset=utf-8', 'text', $5, $6, $7)`,
                  [randomUUID(), u.id, messageId, a.name, data.length, createHash('sha256').update(data).digest(), key],
                );
                files++;
              }
            }
          }
          await audit(q, {
            userId: u.id,
            action: 'import.local',
            ip,
            metadata: { conversations: body.conversations.length, messages, files },
          });
        });
      } catch (e) {
        // A transação foi revertida: remover os blobs já escritos.
        await Promise.all(written.map((k) => storage.delete(k).catch(() => undefined)));
        throw e;
      }
      sendJson(res, 201, { imported: { conversations: body.conversations.length, messages, files } });
    },
    { auth: true },
  );
}
