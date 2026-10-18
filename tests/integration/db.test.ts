import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, PgError, type Db } from '../../server/db/db.ts';
import { migrate } from '../../server/db/migrate.ts';
import { ADMIN_URL, createTestDatabase } from '../helpers/test-db.ts';

let ctx: Awaited<ReturnType<typeof createTestDatabase>>;
let db: Db;

before(async () => {
  ctx = await createTestDatabase();
  db = ctx.db;
});
after(async () => ctx?.drop());

test('autentica com SCRAM-SHA-256 e executa consultas parametrizadas', async () => {
  const r = await db.query<{ a: number; b: string; c: boolean; n: null }>(
    'SELECT $1::int AS a, $2::text AS b, $3::bool AS c, NULL AS n',
    [42, "O'Brien; DROP TABLE users; --", true],
  );
  assert.deepEqual(r.rows[0], { a: 42, b: "O'Brien; DROP TABLE users; --", c: true, n: null });
});

test('converte json, timestamptz, bytea e int8', async () => {
  const when = new Date('2026-10-18T12:34:56.789Z');
  const r = await db.query<{ j: unknown; t: Date; b: Buffer; big: number }>(
    'SELECT $1::jsonb AS j, $2::timestamptz AS t, $3::bytea AS b, 9007199254740991::int8 AS big',
    [{ x: [1, 'á'] }, when, Buffer.from([0, 255, 16])],
  );
  const row = r.rows[0]!;
  assert.deepEqual(row.j, { x: [1, 'á'] });
  assert.equal(row.t.toISOString(), when.toISOString());
  assert.deepEqual([...row.b], [0, 255, 16]);
  assert.equal(row.big, 9007199254740991);
});

test('texto unicode e grandes volumes', async () => {
  const big = 'ç'.repeat(300_000) + '🙂';
  const r = await db.query<{ s: string; l: number }>('SELECT $1::text AS s, length($1::text) AS l', [big]);
  assert.equal(r.rows[0]!.s, big);
  assert.equal(r.rows[0]!.l, 300_001);
});

test('erros do servidor chegam como PgError e a ligação continua utilizável', async () => {
  await assert.rejects(db.query('SELECT * FROM tabela_inexistente'), (e: unknown) => e instanceof PgError && e.code === '42P01');
  const r = await db.query<{ ok: number }>('SELECT 1 AS ok');
  assert.equal(r.rows[0]!.ok, 1);
});

test('transações fazem rollback em caso de erro', async () => {
  await db.query('CREATE TABLE t_tx (v int)');
  await assert.rejects(
    db.tx(async (q) => {
      await q.query('INSERT INTO t_tx VALUES (1)');
      throw new Error('falha');
    }),
  );
  await db.tx(async (q) => q.query('INSERT INTO t_tx VALUES (2)'));
  const r = await db.query<{ v: number }>('SELECT v FROM t_tx');
  assert.deepEqual(r.rows, [{ v: 2 }]);
});

test('pool serve consultas concorrentes acima do tamanho', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => db.query<{ i: number }>('SELECT $1::int AS i, pg_sleep(0.01)', [i])),
  );
  assert.deepEqual(results.map((r) => r.rows[0]!.i), Array.from({ length: 20 }, (_, i) => i));
  assert.ok(db.stats().total <= 5);
});

test('migrações são idempotentes', async () => {
  assert.deepEqual(await migrate(db), []);
});

test('palavra-passe errada é rejeitada', async () => {
  const u = new URL(ADMIN_URL);
  u.password = 'errada';
  const bad = createDb({ url: u.toString(), poolSize: 1 });
  await assert.rejects(bad.query('SELECT 1'), /password authentication failed|autenticação/);
  await bad.close();
});

test('ligação por TLS (sslmode=require)', async (t) => {
  const ssl = await db.query<{ ssl: string }>("SELECT current_setting('ssl') AS ssl");
  if (ssl.rows[0]!.ssl !== 'on') return t.skip('servidor sem TLS ativo (ex.: PostgreSQL de serviço na CI)');
  const u = new URL(ctx.url);
  u.searchParams.set('sslmode', 'require');
  const tlsDb = createDb({ url: u.toString(), poolSize: 1 });
  const r = await tlsDb.query<{ ssl: boolean }>('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
  assert.equal(r.rows[0]!.ssl, true);
  await tlsDb.close();
});

test('statement_timeout aplicado à sessão', async () => {
  const short = createDb({ url: ctx.url, poolSize: 1, statementTimeoutMs: 100 });
  await assert.rejects(short.query('SELECT pg_sleep(1)'), (e: unknown) => e instanceof PgError && e.code === '57014');
  await short.close();
});
