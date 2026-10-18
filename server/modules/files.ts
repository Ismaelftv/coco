/**
 * Upload e download de ficheiros.
 * POST /api/files — corpo binário em bruto; nome em `X-File-Name` (URI-encoded).
 * O ficheiro fica "solto" até ser anexado a uma mensagem; ficheiros soltos
 * com mais de 24 h são apagados pela manutenção.
 */
import { createHash, randomUUID } from 'node:crypto';
import { LIMITS, type FileInfo, type FileKind } from '../../shared/contract.ts';
import type { Db, Queryable } from '../db/db.ts';
import { HttpError, contentDisposition, readRaw, sendJson, uuidParam, type Router } from '../http/http.ts';
import type { ObjectStorage } from '../storage/storage.ts';
import { classify, cleanFileName } from '../storage/sniff.ts';
import { audit } from './audit.ts';
import type { AuthUser } from './auth.ts';

export interface FileRow {
  id: string;
  name: string;
  media_type: string;
  kind: FileKind;
  size_bytes: number;
  storage_key: string;
  message_id: string | null;
  created_at: Date;
}

export const toFileInfo = (r: FileRow): FileInfo => ({
  id: r.id,
  name: r.name,
  mediaType: r.media_type,
  kind: r.kind,
  size: r.size_bytes,
  createdAt: r.created_at.toISOString(),
});

const FILE_COLUMNS = 'id, name, media_type, kind, size_bytes, storage_key, message_id, created_at';

export async function getOwnedFile(q: Queryable, userId: string, id: string): Promise<FileRow | null> {
  const r = await q.query<FileRow>(`SELECT ${FILE_COLUMNS} FROM files WHERE id = $1 AND user_id = $2`, [id, userId]);
  return r.rows[0] ?? null;
}

/** Remove os blobs depois de a transação que apagou as linhas ter terminado. */
export async function deleteBlobs(storage: ObjectStorage, keys: string[], log: (l: string) => void) {
  for (const key of keys) {
    await storage.delete(key).catch((e: Error) => log(`[files] falha a apagar ${key}: ${e.message}`));
  }
}

export function registerFiles(router: Router<AuthUser | null>, db: Db, storage: ObjectStorage, log: (l: string) => void) {
  router.add(
    'POST',
    '/api/files',
    async ({ req, res, user, ip }) => {
      const u = user!;
      const data = await readRaw(req, LIMITS.binaryFileBytes);
      const result = classify(data);
      if (!result.ok) throw new HttpError(result.code === 'file_too_large' ? 413 : 415, result.code, result.message);

      const used = await db.query<{ total: number }>(
        'SELECT COALESCE(SUM(size_bytes), 0)::int8 AS total FROM files WHERE user_id = $1',
        [u.id],
      );
      if ((used.rows[0]?.total ?? 0) + data.length > LIMITS.userStorageBytes) {
        throw new HttpError(413, 'quota_exceeded', 'Atingiste o limite de armazenamento da conta.');
      }

      const id = randomUUID();
      const key = randomUUID();
      const name = cleanFileName(req.headers['x-file-name'] as string | undefined);
      await storage.put(key, data);
      try {
        const r = await db.query<FileRow>(
          `INSERT INTO files (id, user_id, name, media_type, kind, size_bytes, sha256, storage_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${FILE_COLUMNS}`,
          [id, u.id, name, result.detected.mediaType, result.detected.kind, data.length, createHash('sha256').update(data).digest(), key],
        );
        await audit(db, { userId: u.id, action: 'file.upload', target: id, ip, metadata: { kind: result.detected.kind, size: data.length } });
        sendJson(res, 201, { file: toFileInfo(r.rows[0]!) });
      } catch (e) {
        await storage.delete(key).catch(() => undefined);
        throw e;
      }
    },
    { auth: true },
  );

  router.add(
    'GET',
    '/api/files/:id/content',
    async ({ res, params, user }) => {
      const file = await getOwnedFile(db, user!.id, uuidParam(params.id));
      if (!file) throw new HttpError(404, 'not_found', 'Ficheiro não encontrado.');
      const data = await storage.get(file.storage_key);
      const inline = file.kind === 'image';
      res.writeHead(200, {
        'Content-Type': file.media_type,
        'Content-Length': String(data.length),
        'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', file.name),
        'Cache-Control': 'private, max-age=3600',
        // Mesmo que um ficheiro seja aberto diretamente, não pode executar nada.
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    },
    { auth: true },
  );

  router.add(
    'DELETE',
    '/api/files/:id',
    async ({ res, params, user, ip }) => {
      const id = uuidParam(params.id);
      const r = await db.query<{ storage_key: string }>(
        'DELETE FROM files WHERE id = $1 AND user_id = $2 AND message_id IS NULL RETURNING storage_key',
        [id, user!.id],
      );
      const row = r.rows[0];
      if (!row) throw new HttpError(404, 'not_found', 'Ficheiro não encontrado ou já anexado a uma mensagem.');
      await deleteBlobs(storage, [row.storage_key], log);
      await audit(db, { userId: user!.id, action: 'file.delete', target: id, ip });
      res.writeHead(204).end();
    },
    { auth: true },
  );
}
