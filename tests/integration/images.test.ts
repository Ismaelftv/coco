import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { parseCatalog } from '../../server/providers/catalog.ts';
import { createImageGenerator } from '../../server/providers/images.ts';
import { Client, startTestApp } from '../helpers/test-app.ts';
import { PNG, startFakeImageServer } from '../helpers/fake-image-server.ts';

const cfg = (baseUrl: string, extra: Record<string, unknown> = {}) =>
  parseCatalog({ images: { baseUrl, hosting: 'self-hosted', model: 'sd-teste', size: '256x256', timeoutMs: 10_000, ...extra } }).images!;

describe('criação de imagens', () => {
  let fake: Awaited<ReturnType<typeof startFakeImageServer>>;
  let app: Awaited<ReturnType<typeof startTestApp>>;
  let bare: Awaited<ReturnType<typeof startTestApp>>;
  before(async () => {
    fake = await startFakeImageServer();
    app = await startTestApp({ images: createImageGenerator(cfg(fake.url, { apiKeyEnv: 'IMG_KEY' }), { IMG_KEY: 'segredo-123' }) });
    bare = await startTestApp();
  });
  after(async () => { await app.stop(); await bare.stop(); await fake.stop(); });

  const newConv = async (c: Client) => {
    const id = randomUUID();
    const r = await c.json('POST', '/api/conversations', { id, model: 'forja-sim' });
    assert.equal(r.status, 201);
    return id;
  };
  const gen = (c: Client, conv: string, prompt = 'um gato astronauta') =>
    c.json<{ fileId?: string; error?: { code: string; message: string } }>('POST', `/api/conversations/${conv}/images`, { prompt, userMessageId: randomUUID(), assistantMessageId: randomUUID() });

  test('capacidades: indisponível sem configuração, disponível com ela', async () => {
    const a = new Client(app.base); await a.signup('cap-a@exemplo.pt');
    const b = new Client(bare.base); await b.signup('cap-b@exemplo.pt');
    assert.deepEqual((await a.json('GET', '/api/capabilities')).body, { images: { available: true, label: 'Imagens locais', size: '256x256' } });
    assert.deepEqual((await b.json('GET', '/api/capabilities')).body, { images: { available: false } });
    assert.equal((await new Client(app.base).json('GET', '/api/capabilities')).status, 401);
    const conv = await newConv(b);
    assert.equal((await gen(b, conv)).status, 501);
  });

  test('sucesso: grava mensagens e ficheiro, envia chave e parâmetros ao servidor', async () => {
    const c = new Client(app.base); await c.signup('img-ok@exemplo.pt');
    const conv = await newConv(c);
    const before = fake.requests.length;
    const r = await gen(c, conv);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const req = fake.requests[before]!;
    assert.equal(req.url, '/v1/images/generations');
    assert.equal(req.auth, 'Bearer segredo-123');
    assert.equal(req.body.prompt, 'um gato astronauta');
    assert.equal(req.body.size, '256x256');
    assert.equal(req.body.model, 'sd-teste');
    const file = await c.request('GET', `/api/files/${r.body.fileId}/content`);
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
    const detail = await c.json<{ conversation: { title: string; messages: { role: string; content: string; files?: { kind: string }[] }[] } }>('GET', `/api/conversations/${conv}`);
    const roles = detail.body.conversation.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant']);
    assert.equal(detail.body.conversation.messages[0]!.content, 'um gato astronauta');
    assert.equal(detail.body.conversation.messages[1]!.files?.[0]?.kind, 'image');
  });

  test('falhas não gravam nada e dão mensagens claras', async () => {
    const c = new Client(app.base); await c.signup('img-fail@exemplo.pt');
    const conv = await newConv(c);
    const expectFail = async (mode: Parameters<typeof fake.setMode>[0], status: number, code: string) => {
      fake.setMode(mode);
      const r = await gen(c, conv);
      assert.equal(r.status, status, `${mode}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error?.code, code);
    };
    try {
      await expectFail('http-error', 502, 'image_rejected');
      await expectFail('not-image', 502, 'image_bad_response');
      await expectFail('cross-origin-url', 502, 'image_bad_response');
      await expectFail('empty', 502, 'image_bad_response');
    } finally { fake.setMode('ok'); }
    const detail = await c.json<{ conversation: { messages: unknown[] } }>('GET', `/api/conversations/${conv}`);
    assert.equal(detail.body.conversation.messages.length, 0, 'nada foi gravado');
  });

  test('URL da mesma origem é aceite', async () => {
    const c = new Client(app.base); await c.signup('img-url@exemplo.pt');
    const conv = await newConv(c);
    fake.setMode('same-origin-url');
    try { assert.equal((await gen(c, conv)).status, 201); } finally { fake.setMode('ok'); }
  });

  test('propriedade, validação e concorrência', async () => {
    const a = new Client(app.base); await a.signup('img-a@exemplo.pt');
    const b = new Client(app.base); await b.signup('img-b@exemplo.pt');
    const conv = await newConv(a);
    assert.equal((await gen(b, conv)).status, 404, 'outro utilizador não gera na minha conversa');
    assert.equal((await a.json('POST', `/api/conversations/${conv}/images`, { prompt: '  ', userMessageId: randomUUID(), assistantMessageId: randomUUID() })).status, 422);
    fake.setMode('slow');
    try {
      const first = gen(a, conv, 'lenta');
      await new Promise((r) => setTimeout(r, 300));
      const second = await gen(b, await newConv(b));
      assert.equal(second.status, 429);
      assert.equal(second.body.error?.code, 'image_busy');
      assert.equal((await first).status, 201);
    } finally { fake.setMode('ok'); }
  });

  test('tempo limite e servidor inacessível', async () => {
    const slow = await startFakeImageServer('slow');
    try {
      await assert.rejects(() => createImageGenerator(cfg(slow.url, { timeoutMs: 10_000 })).generate('x', AbortSignal.timeout(300)), { code: 'cancelled' });
      const g = createImageGenerator({ ...cfg(slow.url), timeoutMs: 200 });
      await assert.rejects(() => g.generate('x', new AbortController().signal), { code: 'image_timeout' });
    } finally { await slow.stop(); }
    const dead = createImageGenerator(cfg('http://127.0.0.1:1/v1'));
    await assert.rejects(() => dead.generate('x', new AbortController().signal), { code: 'image_unavailable' });
  });
});

describe('catálogo de imagens', () => {
  test('recusa URL remoto em self-hosted e aceita ausência', () => {
    assert.equal(parseCatalog({}).images, undefined);
    assert.throws(() => parseCatalog({ images: { baseUrl: 'http://exemplo.com/v1', hosting: 'self-hosted', model: 'm' } }));
    assert.throws(() => parseCatalog({ images: { baseUrl: 'http://127.0.0.1:8080/v1', hosting: 'self-hosted', model: 'm', size: 'grande' } }));
  });
});
