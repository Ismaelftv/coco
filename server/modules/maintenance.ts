/**
 * Tarefas periódicas. Seguras para correr em várias instâncias em paralelo
 * (operações idempotentes; os ficheiros são reclamados com DELETE … RETURNING).
 */
import type { Db } from '../db/db.ts';
import type { ObjectStorage } from '../storage/storage.ts';
import { deleteBlobs } from './files.ts';

export async function runMaintenance(db: Db, storage: ObjectStorage, log: (l: string) => void) {
  // Gerações cuja instância caiu: sem gravação parcial há mais de 2 minutos.
  const stale = await db.query(
    `UPDATE messages SET status = 'cancelled', updated_at = now()
      WHERE status = 'streaming' AND updated_at < now() - interval '2 minutes'`,
  );
  const sessions = await db.query('DELETE FROM sessions WHERE expires_at < now()');
  const orphans = await db.query<{ storage_key: string }>(
    `DELETE FROM files WHERE message_id IS NULL AND created_at < now() - interval '24 hours' RETURNING storage_key`,
  );
  await deleteBlobs(storage, orphans.rows.map((r) => r.storage_key), log);
  if (stale.rowCount || sessions.rowCount || orphans.rowCount) {
    log(`[manutenção] gerações interrompidas=${stale.rowCount} sessões expiradas=${sessions.rowCount} ficheiros órfãos=${orphans.rowCount}`);
  }
}
