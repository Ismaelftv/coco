import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaBackend } from '../../server/providers/ollama.ts';
import { createOpenAICompatibleBackend } from '../../server/providers/openai-compatible.ts';
import { createModelRegistry } from '../../server/providers/registry.ts';
import { createMockProvider } from '../../server/providers/mock.ts';
import { parseCatalog } from '../../server/providers/catalog.ts';
import type { BackendRequest, ModelBackend, ProviderEvent } from '../../server/providers/types.ts';
import { startFakeModelServer, type FakeModelServer } from '../helpers/fake-model-server.ts';

let fake: FakeModelServer;
before(async () => {
  fake = await startFakeModelServer({ models: ['qwen3:4b', 'outro:1b'] });
});
after(async () => fake?.close());

const req = (content: string, extra: Partial<BackendRequest> = {}): BackendRequest => ({
  model: 'local',
  upstreamModel: 'qwen3:4b',
  contextTokens: 8192,
  think: false,
  maxOutputTokens: 256,
  system: 'Sistema de teste',
  messages: [{ role: 'user', content }],
  ...extra,
});

async function collect(it: AsyncIterable<ProviderEvent>) {
  const events: ProviderEvent[] = [];
  for await (const e of it) events.push(e);
  const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');
  const reasoning = events.filter((e) => e.type === 'reasoning').map((e) => (e as { text: string }).text).join('');
  return { events, text, reasoning, last: events.at(-1)! };
}

const backends: [string, () => ModelBackend][] = [
  ['ollama (API nativa)', () => createOllamaBackend({ id: 'o', baseUrl: fake.url })],
  ['compatível com OpenAI', () => createOpenAICompatibleBackend({ id: 'v', baseUrl: `${fake.url}/v1` })],
];

for (const [name, make] of backends) {
  describe(`backend ${name}`, () => {
    test('transmite a resposta e devolve contagem real de tokens', async () => {
      const r = await collect(make().stream(req('olá mundo'), new AbortController().signal));
      assert.match(r.text, /^Resposta do modelo de teste para: olá mundo/);
      assert.deepEqual(r.last, { type: 'end', finishReason: 'stop', usage: { inputTokens: 42, outputTokens: r.events.filter((e) => e.type === 'delta').length, estimated: false } });
      const sent = fake.requests.at(-1)!.body;
      assert.equal((sent.messages as { role: string }[])[0]!.role, 'system', 'prompt de sistema enviado');
    });

    test('separa o raciocínio interno da resposta', async () => {
      const r = await collect(make().stream(req('#pensar'), new AbortController().signal));
      assert.ok(r.reasoning.length > 0);
      assert.doesNotMatch(r.text, /think|pondera|raciocínio|pensamento/);
      assert.match(r.text, /^Resposta do modelo/);
    });

    test('limite de tokens → finishReason "length"', async () => {
      const r = await collect(make().stream(req('#longo'), new AbortController().signal));
      assert.equal((r.last as { finishReason: string }).finishReason, 'length');
    });

    test('erro HTTP do servidor → erro genérico, sem detalhes internos', async () => {
      const r = await collect(make().stream(req('#erro-http'), new AbortController().signal));
      assert.equal(r.last.type, 'error');
      assert.equal((r.last as { code: string }).code, 'model_error');
      assert.doesNotMatch(JSON.stringify(r.last), /segredo|\/srv/);
    });

    test('erro a meio do stream', async () => {
      const r = await collect(make().stream(req('#erro-stream'), new AbortController().signal));
      assert.ok(r.text.length > 0);
      assert.equal((r.last as { code: string }).code, 'model_error');
    });

    test('modelo não instalado → model_not_found', async () => {
      const r = await collect(make().stream(req('x', { upstreamModel: 'nao-existe:1b' }), new AbortController().signal));
      assert.equal((r.last as { code: string }).code, 'model_not_found');
    });

    test('cancelar fecha a ligação ao servidor de modelos', async () => {
      const controller = new AbortController();
      const events: ProviderEvent[] = [];
      for await (const e of make().stream(req('#lento resposta comprida'), controller.signal)) {
        events.push(e);
        if (events.length === 2) controller.abort();
      }
      assert.deepEqual(events.at(-1)?.type, 'end');
      assert.equal((events.at(-1) as { finishReason: string }).finishReason, 'cancelled');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(fake.requests.at(-1)!.aborted, true);
    });

    test('lista os modelos instalados no servidor', async () => {
      assert.deepEqual(await make().listUpstreamModels(new AbortController().signal), ['qwen3:4b', 'outro:1b']);
    });
  });
}

test('servidor desligado → model_offline e listagem nula', async () => {
  const dead = createOllamaBackend({ id: 'x', baseUrl: 'http://127.0.0.1:9' });
  const r = await collect(dead.stream(req('olá'), new AbortController().signal));
  assert.equal((r.last as { code: string }).code, 'model_offline');
  assert.equal(await dead.listUpstreamModels(new AbortController().signal), null);
});

test('API nativa do Ollama: contexto, limite e raciocínio desligado são enviados', async () => {
  await collect(createOllamaBackend({ id: 'o', baseUrl: fake.url }).stream(req('x', { contextTokens: 16384, maxOutputTokens: 300 }), new AbortController().signal));
  const body = fake.requests.at(-1)!.body;
  assert.equal(body.think, false);
  assert.deepEqual(body.options, { num_ctx: 16384, num_predict: 300 });
});

test('a chave só é enviada quando configurada', async () => {
  await collect(createOpenAICompatibleBackend({ id: 'v', baseUrl: `${fake.url}/v1` }).stream(req('x'), new AbortController().signal));
  assert.equal(fake.requests.at(-1)!.headers.authorization, undefined);
  await collect(createOpenAICompatibleBackend({ id: 'v', baseUrl: `${fake.url}/v1`, apiKey: 'sk-teste' }).stream(req('x'), new AbortController().signal));
  assert.equal(fake.requests.at(-1)!.headers.authorization, 'Bearer sk-teste');
});

test('tempo limite sem dados → model_timeout', async () => {
  // Servidor que aceita a ligação mas nunca responde.
  const { createServer } = await import('node:http');
  const silent = createServer(() => {});
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
  const port = (silent.address() as { port: number }).port;
  const stuck = createOllamaBackend({ id: 's', baseUrl: `http://127.0.0.1:${port}`, headersTimeoutMs: 1_000 });
  const r = await collect(stuck.stream(req('x'), new AbortController().signal));
  assert.equal((r.last as { code: string }).code, 'model_timeout');
  silent.closeAllConnections();
  silent.close();
});

describe('registo de modelos', () => {
  const catalog = () =>
    parseCatalog({
      backends: [
        { id: 'ollama-local', kind: 'ollama', baseUrl: fake.url, hosting: 'self-hosted' },
        { id: 'externo', kind: 'openai-compatible', baseUrl: 'https://api.exemplo.com/v1', hosting: 'external', apiKeyEnv: 'FORJA_TESTE_CHAVE' },
      ],
      models: [
        { id: 'qwen3-4b', label: 'Qwen3 4B', backend: 'ollama-local', upstreamModel: 'qwen3:4b', author: 'Alibaba (Qwen)', license: 'Apache-2.0', contextTokens: 8192, maxOutputTokens: 1024 },
        { id: 'em-falta', label: 'Em falta', backend: 'ollama-local', upstreamModel: 'nao-instalado:7b', contextTokens: 8192, maxOutputTokens: 1024 },
        { id: 'externo-1', label: 'Externo', backend: 'externo', upstreamModel: 'x', contextTokens: 8192, maxOutputTokens: 1024 },
      ],
    });

  test('estados após verificação; integração externa sem chave não é registada', async () => {
    const registry = createModelRegistry({ catalog: catalog(), simulator: createMockProvider({ delayMs: 0 }), env: {} });
    await registry.refresh();
    const byId = Object.fromEntries(registry.models.map((m) => [m.id, m]));
    assert.equal(byId['qwen3-4b']!.status, 'available');
    assert.equal(byId['qwen3-4b']!.hosting, 'self-hosted');
    assert.equal(byId['em-falta']!.status, 'offline');
    assert.match(byId['em-falta']!.statusDetail ?? '', /não está instalado/);
    assert.equal(byId['externo-1'], undefined, 'sem FORJA_TESTE_CHAVE o backend externo é ignorado');
    assert.equal(byId['forja-sim']!.status, 'simulated');
    assert.deepEqual(registry.models.map((m) => m.id), ['qwen3-4b', 'em-falta', 'forja-sim'], 'modelos próprios primeiro');
  });

  test('com a chave no ambiente, a integração externa aparece — sem expor URL nem chave', async () => {
    const registry = createModelRegistry({ catalog: catalog(), env: { FORJA_TESTE_CHAVE: 'sk-segredo' } });
    const ext = registry.models.find((m) => m.id === 'externo-1');
    assert.equal(ext?.hosting, 'external');
    const exposed = JSON.stringify(registry.models);
    assert.doesNotMatch(exposed, /sk-segredo|api\.exemplo\.com|127\.0\.0\.1|nao-instalado/);
  });

  test('encaminha para o backend certo, aplica limites e simulador continua a funcionar', async () => {
    const registry = createModelRegistry({ catalog: catalog(), simulator: createMockProvider({ delayMs: 0 }), env: {} });
    const r = await collect(registry.stream({ model: 'qwen3-4b', messages: [{ role: 'user', content: 'olá' }], maxOutputTokens: 99_999 }, new AbortController().signal));
    assert.match(r.text, /Resposta do modelo de teste/);
    assert.equal((fake.requests.at(-1)!.body.options as { num_predict: number }).num_predict, 1024, 'teto do catálogo aplicado');
    assert.deepEqual(registry.limits?.('qwen3-4b'), { contextTokens: 8192, maxOutputTokens: 1024 });
    const sim = await collect(registry.stream({ model: 'forja-sim', messages: [{ role: 'user', content: 'olá' }] }, new AbortController().signal));
    assert.match(sim.text, /Resposta simulada/);
    const unknown = await collect(registry.stream({ model: 'nada', messages: [] }, new AbortController().signal));
    assert.equal((unknown.last as { code: string }).code, 'unknown_model');
  });

  test('servidor desligado → modelo indisponível; volta quando o servidor regressa', async () => {
    const temp = await startFakeModelServer({ models: ['qwen3:0.6b'] });
    const port = new URL(temp.url).port;
    const registry = createModelRegistry({
      catalog: parseCatalog({
        backends: [{ id: 'b', kind: 'ollama', baseUrl: temp.url, hosting: 'self-hosted' }],
        models: [{ id: 'm', label: 'M', backend: 'b', upstreamModel: 'qwen3:0.6b', contextTokens: 4096, maxOutputTokens: 512 }],
      }),
    });
    await registry.refresh();
    assert.equal(registry.models[0]!.status, 'available');
    await temp.close();
    await registry.refresh();
    assert.equal(registry.models[0]!.status, 'offline');
    const again = await startFakeModelServer({ models: ['qwen3:0.6b'], port: Number(port) });
    await registry.refresh();
    assert.equal(registry.models[0]!.status, 'available');
    await again.close();
  });
});
