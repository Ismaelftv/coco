/**
 * Cria uma base de dados descartável por ficheiro de teste no servidor
 * indicado por TEST_DATABASE_URL (por defeito, o cluster de scripts/pg-local.sh).
 */
import { randomBytes } from 'node:crypto';
import { createDb, type Db } from '../../server/db/db.ts';
import { migrate } from '../../server/db/migrate.ts';

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://forja:forja-dev-only@127.0.0.1:54329/postgres';

export function urlFor(database: string, base = ADMIN_URL): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

export async function createTestDatabase(): Promise<{ db: Db; url: string; drop(): Promise<void> }> {
  const name = `forja_test_${randomBytes(6).toString('hex')}`;
  const admin = createDb({ url: ADMIN_URL, poolSize: 1 });
  await admin.query(`CREATE DATABASE ${name}`); // nome gerado aqui, nunca vindo de fora
  const url = urlFor(name);
  const db = createDb({ url, poolSize: 5 });
  await migrate(db);
  return {
    db,
    url,
    async drop() {
      await db.close();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}
