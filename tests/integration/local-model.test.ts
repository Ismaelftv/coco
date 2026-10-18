/**
 * Conversa completa pela API com um modelo "local" (servidor falso que fala a
 * API do Ollama): prova que a aplicação funciona sem qualquer API comercial.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseCatalog } from '../../server/providers/catalog.ts';
import { createMockProvider } from '../../server/providers/mock.ts';
import { createModelRegistry, type ModelRegistry } from '../../server/providers/registry.ts';
import { startFakeModelServer, type FakeModelServer } from '../helpers/fake-model-server.ts';
import { Client, parseSse, startTestApp } from '../helpers/test-app.ts';

let fake: FakeModelServer;
let registry: ModelRegistry;
let app: Awaited<ReturnType<typeof startTestApp>>;

before(async () => {
  fake = await startFakeModelServer({ models: ['qwen3:4b'] });
  registry = createModelRegistry({
    catalog: parseCatalog({
      backends: [
        { id: 'ollama-local', kind: 'ollama', baseUrl: fake.url, hosting: 'self-hosted' },
        { id: 'parado', kind: 'ollama', baseUrl: 'http://127.0.0.1:9', hosting: 'self-hosted' },
      ],
      models: [
        { id: 'qwen3-4b-local', label: 'Qwen3 4B', backend: 'ollama-local', upstreamModel: 'qwen3:4b', author: 'Alibaba (Qwen)', license: 'Apache-2.0', contextTokens: 4096, maxOutputTokens: 512 },
        { id: 'desligado', label: 'Desligado', backend: 'parado', upstreamModel: 'x:1b', contextTokens: 4096, maxOutputTokens: 512 },
      ],
    }),
    simulator: createMockProvider({ delayMs: 0 }),
  });
  await registry.refresh();
  app = await startTestApp({ provider: registry });
});
after(async () => {
  await app?.stop();
  await fake?.close();
});

async function newConversation(c: Client, model: string) {
  const id = randomUUID();
  assert.equal((await c.json('POST', '/api/conversations', { id, model })).status, 201);
  return id;
}

test('/api/models expõe estado, alojamento e licença — sem URLs nem nomes internos', async () => {
  const c = new Client(app.base);
  await c.signup(`m-${randomUUID().slice(0, 6)}@exemplo.pt`);
  const r = await c.json<{ models: { id: string; status: string; hosting: string; license: string | null }[] }>('GET', '/api/models');
  const local = r.body.models.find((m) => m.id === 'qwen3-4b-local');
  assert.equal(local?.status, 'available');
  assert.equal(local?.hosting, 'self-hosted');
  assert.equal(local?.license, 'Apache-2.0');
  assert.equal(r.body.models.find((m) => m.id === 'desligado')?.status, 'offline');
  assert.doesNotMatch(JSON.stringify(r.body), /127\.0\.0\.1|qwen3:4b|baseUrl|upstream/);
});

test('conversa com o modelo local: resposta gravada, tokens reais e prompt de sistema honesto', async () => {
  const c = new Client(app.base);
  await c.signup(`l-${randomUUID().slice(0, 6)}@exemplo.pt`);
  const id = await newConversation(c, 'qwen3-4b-local');
  const assistantId = randomUUID();
  const res = await c.request('POST', `/api/conversations/${id}/messages`, {
    mode: 'send',
    model: 'qwen3-4b-local',
    userMessage: { id: randomUUID(), content: 'Olá #pensar', fileIds: [] },
    assistantMessageId: assistantId,
  });
  const events = parseSse(await res.text());
  const text = events.filter((e) => e.type === 'delta').map((e) => e.data.text).join('');
  assert.match(text, /^Resposta do modelo de teste para: Olá/);
  assert.doesNotMatch(text, /pondera/, 'raciocínio não aparece na resposta');
  const end = events.at(-1)!;
  assert.equal(end.type, 'message.end');
  assert.equal((end.data.usage as { estimated: boolean }).estimated, false);

  const sent = fake.requests.filter((r) => r.path === '/api/chat').at(-1)!.body;
  const system = (sent.messages as { role: string; content: string }[])[0]!;
  assert.equal(system.role, 'system');
  assert.match(system.content, /Qwen3 4B.*Alibaba.*Apache-2\.0/s);
  assert.match(system.content, /Não afirmes ter sido desenvolvido de raiz pela Forja/);
  assert.equal((sent.options as { num_ctx: number }).num_ctx, 4096);

  const detail = await c.json<{ conversation: { messages: { id: string; content: string; status: string; usage: { estimated: boolean } }[] } }>('GET', `/api/conversations/${id}`);
  const saved = detail.body.conversation.messages.find((m) => m.id === assistantId)!;
  assert.equal(saved.status, 'complete');
  assert.equal(saved.content, text);
  assert.equal(saved.usage.estimated, false);
});

test('o contexto enviado respeita a janela do modelo', async () => {
  const c = new Client(app.base);
  await c.signup(`h-${randomUUID().slice(0, 6)}@exemplo.pt`);
  const id = await newConversation(c, 'qwen3-4b-local');
  // Cada mensagem ≈ 2 000 tokens estimados; a janela é de 4 096 com 512 de resposta.
  for (let i = 0; i < 3; i++) {
    const r = await c.request('POST', `/api/conversations/${id}/messages`, {
      mode: 'send', model: 'qwen3-4b-local',
      userMessage: { id: randomUUID(), content: `m${i} ${'x'.repeat(8_000)}`, fileIds: [] },
      assistantMessageId: randomUUID(),
    });
    await r.text();
  }
  const sent = fake.requests.filter((r) => r.path === '/api/chat').at(-1)!.body;
  const msgs = sent.messages as { role: string; content: string }[];
  const chars = msgs.reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars / 4 < 4096 - 512, `contexto estimado ${Math.round(chars / 4)} tokens excede a janela`);
  assert.match(msgs.at(-1)!.content, /^m2 /, 'a mensagem atual é sempre incluída');
  assert.equal(msgs[1]!.role, 'user', 'o histórico começa num turno do utilizador');
});

test('modelo indisponível → 409 com explicação; erro do servidor de modelos fica gravado', async () => {
  const c = new Client(app.base);
  await c.signup(`d-${randomUUID().slice(0, 6)}@exemplo.pt`);
  const id = await newConversation(c, 'desligado');
  const r = await c.json<{ error: { code: string; message: string } }>('POST', `/api/conversations/${id}/messages`, {
    mode: 'send', model: 'desligado', userMessage: { id: randomUUID(), content: 'olá', fileIds: [] }, assistantMessageId: randomUUID(),
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /indisponível/);

  const id2 = await newConversation(c, 'qwen3-4b-local');
  const assistantId = randomUUID();
  const res = await c.request('POST', `/api/conversations/${id2}/messages`, {
    mode: 'send', model: 'qwen3-4b-local', userMessage: { id: randomUUID(), content: 'falha #erro-stream', fileIds: [] }, assistantMessageId: assistantId,
  });
  const events = parseSse(await res.text());
  assert.equal(events.at(-1)?.type, 'error');
  const detail = await c.json<{ conversation: { messages: { id: string; status: string; error: { code: string } }[] } }>('GET', `/api/conversations/${id2}`);
  const saved = detail.body.conversation.messages.find((m) => m.id === assistantId)!;
  assert.equal(saved.status, 'error');
  assert.equal(saved.error.code, 'model_error');
});
