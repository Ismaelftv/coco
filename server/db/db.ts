/**
 * Interface de acesso à base de dados usada por todo o servidor.
 * A implementação atual usa o cliente temporário `pg-wire.ts`; trocar por
 * `pg.Pool` só exige reescrever este ficheiro.
 */
import { PgConnection, parseDatabaseUrl, type PgConfig, type PgParam, type PgResult } from './pg-wire.ts';

export { PgError } from './pg-wire.ts';
export type { PgParam };

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

export function createDb(options: DbOptions): Db {
  const base = parseDatabaseUrl(options.url);
  const config: PgConfig = {
    ...base,
    connectTimeoutMs: options.connectTimeoutMs ?? 5_000,
    runtimeParams: {
      application_name: options.applicationName ?? 'forja',
      statement_timeout: String(options.statementTimeoutMs ?? 15_000),
      idle_in_transaction_session_timeout: '30000',
      client_encoding: 'UTF8',
      TimeZone: 'UTC',
    },
  };
  const max = options.poolSize ?? 10;
  const idle: PgConnection[] = [];
  const waiting: ((c: PgConnection) => void)[] = [];
  let total = 0;
  let closing = false;

  async function acquire(): Promise<PgConnection> {
    if (closing) throw new Error('Base de dados a fechar');
    while (idle.length) {
      const c = idle.pop()!;
      if (!c.closed) return c;
      total--;
    }
    if (total < max) {
      total++;
      try {
        return await PgConnection.connect(config);
      } catch (e) {
        total--;
        throw e;
      }
    }
    return new Promise((resolve) => waiting.push(resolve));
  }

  function release(c: PgConnection) {
    if (c.closed) {
      total--;
      // Uma ligação partida liberta espaço: acorda quem espera com uma ligação nova.
      const w = waiting.shift();
      if (w) {
        total++;
        PgConnection.connect(config).then(w, () => {
          total--;
        });
      }
      return;
    }
    const w = waiting.shift();
    if (w) w(c);
    else idle.push(c);
  }

  return {
    async query(sql, params = []) {
      const c = await acquire();
      try {
        return await c.query(sql, params);
      } finally {
        release(c);
      }
    },
    async tx(fn) {
      const c = await acquire();
      try {
        await c.query('BEGIN');
        try {
          const client: TxClient = {
            query: <R,>(sql: string, params: readonly PgParam[] = []) => c.query<R>(sql, params),
            exec: (sql: string) => c.exec(sql),
          };
          const result = await fn(client);
          await c.query('COMMIT');
          return result;
        } catch (e) {
          if (!c.closed) await c.query('ROLLBACK').catch(() => undefined);
          throw e;
        }
      } finally {
        release(c);
      }
    },
    async close() {
      closing = true;
      await Promise.all(idle.splice(0).map((c) => c.close()));
    },
    stats: () => ({ total, idle: idle.length, waiting: waiting.length }),
  };
}
