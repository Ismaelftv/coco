import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { createApp } from '../../server/app.ts';
import { createMockProvider, chunk } from '../../server/providers/mock.ts';
import { trimHistory } from '../../server/context.ts';
import { createRateLimiter } from '../../server/rate-limit.ts';
import { createSseParser } from '../../apps/web/src/lib/sse.ts';

let server: Server;
let base: string;
let staticDir: string;

before(async () => {
  staticDir = await mkdtemp(join(tmpdir(), 'forja-static-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>t</title>');
  server = createApp({ provider: createMockProvider({ delayMs: 0 }), staticDir, chatPerMinute: 1000 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(staticDir, { recursive: true, force: true });
});

function rawGet(path: string): Promise<{ status: number; body: string }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => (data += c.toString()));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

const body = (content: string, model = 'forja-sim') =>
  JSON.stringify({ conversationId: 'c1', model, messages: [{ role: 'user', content }] });

async function chatEvents(content: string) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body(content),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const parser = createSseParser();
  const events = [...parser.feed(await res.text()), ...parser.flush()];
  return events.map((e) => ({ type: e.event, data: JSON.parse(e.data) as Record<string, unknown> }));
}

test('GET /api/models lista modelos com estado', async () => {
  const res = await fetch(`${base}/api/models`);
  const json = (await res.json()) as { models: { id: string; status: string }[] };
  assert.ok(json.models.some((m) => m.id === 'forja-sim' && m.status === 'simulated'));
  assert.ok(json.models.some((m) => m.status === 'requires-integration'));
});

test('POST /api/chat transmite start → deltas → end', async () => {
  const events = await chatEvents('mostra código');
  assert.equal(events[0]?.type, 'message.start');
  assert.equal(events.at(-1)?.type, 'message.end');
  const text = events.filter((e) => e.type === 'delta').map((e) => e.data.text).join('');
  assert.match(text, /Resposta simulada/);
  assert.match(text, /```typescript/);
});

test('#erro produz evento de erro recuperável', async () => {
  const events = await chatEvents('falha #erro');
  const last = events.at(-1);
  assert.equal(last?.type, 'error');
  assert.equal(last?.data.retryable, true);
});

test('valida o pedido', async () => {
  const post = (b: string, type = 'application/json') =>
    fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': type }, body: b });
  assert.equal((await post('{x')).status, 400);
  assert.equal((await post('{}')).status, 422);
  assert.equal((await post(body('x'), 'text/plain')).status, 415);
  assert.equal((await post(body('x', 'nao-existe'))).status, 422);
  assert.equal((await post(body('x', 'anthropic'))).status, 409);
  assert.equal((await post(body('a'.repeat(40_000)))).status, 422);
  const assistantLast = JSON.stringify({ conversationId: 'c', model: 'forja-sim', messages: [{ role: 'assistant', content: 'x' }] });
  assert.equal((await post(assistantLast)).status, 422);
  assert.equal((await fetch(`${base}/api/chat`)).status, 405);
});

test('cabeçalhos de segurança e proteção contra path traversal', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  // fetch normaliza "..", por isso o pedido é feito em bruto com barras codificadas.
  const traversal = await rawGet('/..%2f..%2f..%2fetc%2fpasswd');
  assert.equal(traversal.status, 403);
  assert.doesNotMatch(traversal.body, /root:/);
  assert.equal((await fetch(`${base}/inexistente.js`)).status, 404);
  assert.equal((await fetch(`${base}/conversa/abc`)).status, 200); // rota da SPA
});

test('cancelamento a meio do stream não deixa o servidor em erro', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body('#lento'),
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read());
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
});

test('trimHistory mantém a última mensagem e começa num turno do utilizador', () => {
  const msgs = [
    { role: 'user' as const, content: 'a'.repeat(400) },
    { role: 'assistant' as const, content: 'b'.repeat(400) },
    { role: 'user' as const, content: 'c'.repeat(40) },
  ];
  assert.equal(trimHistory(msgs, 10_000).length, 3);
  const trimmed = trimHistory(msgs, 150);
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0]!.content[0], 'c');
  // Mesmo acima do orçamento, a última mensagem é sempre incluída.
  assert.equal(trimHistory([{ role: 'user', content: 'x'.repeat(10_000) }], 1).length, 1);
});

test('chunk preserva o texto original', () => {
  const text = 'linha um\n\n```ts\nconst a = 1;\n```\nfim';
  assert.equal(chunk(text).join(''), text);
});

test('rate limiter recusa acima da capacidade e recupera com o tempo', () => {
  const rl = createRateLimiter(2, 1);
  assert.equal(rl.take('ip', 0), true);
  assert.equal(rl.take('ip', 0), true);
  assert.equal(rl.take('ip', 0), false);
  assert.equal(rl.take('ip', 1500), true);
  assert.equal(rl.take('outro', 0), true);
});
