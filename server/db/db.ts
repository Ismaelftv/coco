/**
 * Interface de acesso à base de dados usada por todo o servidor,
 * implementada sobre `pg` (node-postgres). O resto do código depende apenas
 * destes tipos, não do driver.
 */
import pg from 'pg';

export const PgError = pg.DatabaseError;
export type PgError = pg.DatabaseError;

export type PgParam = string | number | bigint | boolean | Date | Buffer | null | undefined | object;

export interface PgResult<R> {
  rows: R[];
  rowCount: number;
  command: string;
}

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: readonly PgParam[]): Promise<PgResult<R>>;
}

/** Ligação fixa de uma transação; `exec` só para SQL de migrações. */
export interface TxClient extends Queryable {
  exec(sql: string): Promise<unknown>;
}

export interface Db extends Queryable {
  /** Executa `fn` numa transação; faz ROLLBACK se lançar. */
  tx<T>(fn: (q: TxClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  stats(): { total: number; idle: number; waiting: number };
}

export interface DbOptions {
  url: string;
  poolSize?: number;
  statementTimeoutMs?: number;
  connectTimeoutMs?: number;
  applicationName?: string;
}

// int8 (COUNT, SUM, ids) como number quando é seguro; senão texto, sem perder precisão.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});

/** Valores JSON vão sempre como texto JSON (o pg converteria arrays em arrays do PostgreSQL). */
function prepare(params: readonly PgParam[]): unknown[] {
  return params.map((p) =>
    p !== null && typeof p === 'object' && !(p instanceof Date) && !Buffer.isBuffer(p) ? JSON.stringify(p) : p,
  );
}

/**
 * `sslmode` é interpretado aqui, explicitamente: `require` cifra sem validar o
 * certificado; `verify-full` valida certificado e nome do servidor.
 */
function poolConfig(options: DbOptions): pg.PoolConfig {
  const url = new URL(options.url);
  const sslmode = url.searchParams.get('sslmode') ?? 'disable';
  url.searchParams.delete('sslmode');
  let ssl: pg.PoolConfig['ssl'] = false;
  if (sslmode === 'require') ssl = { rejectUnauthorized: false };
  else if (sslmode === 'verify-full') ssl = { rejectUnauthorized: true, servername: url.hostname };
  else if (sslmode !== 'disable') throw new Error(`sslmode não suportado: ${sslmode}`);
  return {
    connectionString: url.toString(),
    ssl,
    max: options.poolSize ?? 10,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 5_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: options.applicationName ?? 'forja',
    options: '-c TimeZone=UTC',
  };
}

function wrap<R>(r: pg.QueryResult): PgResult<R> {
  return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length, command: r.command };
}

export function createDb(options: DbOptions): Db {
  const pool = new pg.Pool(poolConfig(options));
  // Um erro numa ligação inativa (ex.: servidor reiniciado) não deve derrubar o processo.
  pool.on('error', (e) => console.error(`[db] ligação inativa falhou: ${e.message}`));

  return {
    async query<R>(sql: string, params: readonly PgParam[] = []) {
      return wrap<R>(await pool.query(sql, prepare(params)));
    },
    async tx<T>(fn: (q: TxClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        const tx: TxClient = {
          query: async <R,>(sql: string, params: readonly PgParam[] = []) => wrap<R>(await client.query(sql, prepare(params))),
          // Sem parâmetros o pg usa o protocolo simples, que aceita várias instruções.
          exec: (sql: string) => client.query(sql),
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {
          broken = true;
        });
        throw e;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
    stats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
  };
}
