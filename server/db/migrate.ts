/**
 * Migrações SQL versionadas (server/db/migrations/NNNN_nome.sql).
 * Cada ficheiro corre numa transação, protegida por um advisory lock para que
 * várias instâncias a arrancar ao mesmo tempo não apliquem a mesma migração.
 * Um ficheiro já aplicado não pode mudar: o checksum é verificado.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Db } from './db.ts';

const DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const LOCK_KEY = 4_242_001;

export async function migrate(db: Db, log: (l: string) => void = () => {}): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(DIR)).filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    const sql = await readFile(join(DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const done = await db.tx(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const existing = await q.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [file],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Migração ${file} foi alterada depois de aplicada.`);
        }
        return false;
      }
      await q.exec(sql);
      await q.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
      return true;
    });
    if (done) {
      applied.push(file);
      log(`[migrate] aplicada ${file}`);
    }
  }
  return applied;
}
