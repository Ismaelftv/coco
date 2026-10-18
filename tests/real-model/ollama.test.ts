/**
 * Teste com um modelo REAL a correr no Ollama. Só corre se OLLAMA_URL estiver
 * definido (ex.: na CI, workflow "Modelo local"). Usa config/models.ci.json.
 * Valida a integração, não a qualidade das respostas.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadCatalog } from '../../server/providers/catalog.ts';
import { createModelRegistry, type ModelRegistry } from '../../server/providers/registry.ts';
import { Client, parseSse, startTestApp } from '../helpers/test-app.ts';

const OLLAMA_URL = process.env.OLLAMA_URL;
const skip = !OLLAMA_URL && 'OLLAMA_URL não definido';

let registry: ModelRegistry;
let app: Awaited<ReturnType<typeof startTestApp>>;

before(async () => {
  if (skip) return;
  const catalog = await loadCatalog('config/models.ci.json');
  catalog.backends[0]!.baseUrl = OLLAMA_URL!;
  registry = createModelRegistry({ catalog, log: (l) => console.log(l) });
  await registry.refresh();
  app = await startTestApp({ provider: registry });
});
after(async () => app?.stop());

test('o modelo local está disponível', { skip }, () => {
  const m = registry.models.find((x) => x.id === 'qwen3-0-6b-ci');
  assert.equal(m?.status, 'available', m?.statusDetail ?? '');
});

test('conversa completa pela API com o modelo real', { skip, timeout: 600_000 }, async () => {
  const c = new Client(app.base);
  await c.signup(`real-${randomUUID().slice(0, 6)}@exemplo.pt`);
  const id = randomUUID();
  await c.json('POST', '/api/conversations', { id, model: 'qwen3-0-6b-ci' });
  const assistantId = randomUUID();
  const started = Date.now();
  const res = await c.request('POST', `/api/conversations/${id}/messages`, {
    mode: 'send',
    model: 'qwen3-0-6b-ci',
    userMessage: { id: randomUUID(), content: 'Diz olá em português, numa frase curta.', fileIds: [] },
    assistantMessageId: assistantId,
  });
  const events = parseSse(await res.text());
  const text = events.filter((e) => e.type === 'delta').map((e) => e.data.text).join('');
  const end = events.at(-1)!;
  console.log(`Resposta (${Date.now() - started} ms): ${text.slice(0, 200)}`);
  assert.equal(end.type, 'message.end', JSON.stringify(end.data));
  assert.ok(text.trim().length > 0, 'resposta não vazia');
  assert.doesNotMatch(text, /<\/?think>/, 'sem raciocínio na resposta');
  assert.equal((end.data.usage as { estimated: boolean }).estimated, false, 'tokens contados pelo servidor');

  const detail = await c.json<{ conversation: { messages: { id: string; status: string; content: string }[] } }>('GET', `/api/conversations/${id}`);
  const saved = detail.body.conversation.messages.find((m) => m.id === assistantId)!;
  assert.equal(saved.status, 'complete');
  assert.equal(saved.content, text);
});

test('cancelar a geração liberta o modelo e grava o parcial', { skip, timeout: 600_000 }, async () => {
  const c = new Client(app.base);
  await c.signup(`cancel-${randomUUID().slice(0, 6)}@exemplo.pt`);
  const id = randomUUID();
  await c.json('POST', '/api/conversations', { id, model: 'qwen3-0-6b-ci' });
  const assistantId = randomUUID();
  const controller = new AbortController();
  const res = await fetch(`${app.base}/api/conversations/${id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app.base, Cookie: c.cookie },
    body: JSON.stringify({
      mode: 'send', model: 'qwen3-0-6b-ci',
      userMessage: { id: randomUUID(), content: 'Escreve uma lista numerada de 30 frutas, uma por linha.', fileIds: [] },
      assistantMessageId: assistantId,
    }),
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.includes('event: delta')) seen += decoder.decode((await reader.read()).value);
  controller.abort();
  let status = 'streaming';
  for (let i = 0; i < 100 && status === 'streaming'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const d = await c.json<{ conversation: { messages: { id: string; status: string }[] } }>('GET', `/api/conversations/${id}`);
    status = d.body.conversation.messages.find((m) => m.id === assistantId)!.status;
  }
  assert.equal(status, 'cancelled');
});
