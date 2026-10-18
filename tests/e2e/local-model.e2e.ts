/**
 * E2E com um modelo "local" (servidor falso com a API do Ollama): seletor de
 * modelos, estados de disponibilidade e conversa sem qualquer API comercial.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { parseCatalog } from '../../server/providers/catalog.ts';
import { createMockProvider } from '../../server/providers/mock.ts';
import { createModelRegistry } from '../../server/providers/registry.ts';
import { startFakeModelServer, type FakeModelServer } from '../helpers/fake-model-server.ts';
import { Client, startTestApp } from '../helpers/test-app.ts';

const dist = fileURLToPath(new URL('../../dist', import.meta.url));
const shots = process.env.E2E_SCREENSHOTS;
let fake: FakeModelServer;
let app: Awaited<ReturnType<typeof startTestApp>>;
let browser: Browser;

before(async () => {
  fake = await startFakeModelServer({ models: ['qwen3:4b'] });
  const registry = createModelRegistry({
    catalog: parseCatalog({
      backends: [
        { id: 'ollama-local', kind: 'ollama', baseUrl: fake.url, hosting: 'self-hosted' },
        { id: 'vllm', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', hosting: 'self-hosted' },
      ],
      models: [
        { id: 'qwen3-4b-local', label: 'Qwen3 4B', description: 'Desenvolvimento local (CPU).', backend: 'ollama-local', upstreamModel: 'qwen3:4b', author: 'Alibaba (Qwen)', license: 'Apache-2.0', contextTokens: 8192, maxOutputTokens: 1024 },
        { id: 'qwen3-8-27b-vllm', label: 'Qwen3.8 27B (vLLM)', backend: 'vllm', upstreamModel: 'Qwen/Qwen3.8-27B', author: 'Alibaba (Qwen)', license: 'Apache-2.0', contextTokens: 32768, maxOutputTokens: 4096 },
      ],
    }),
    simulator: createMockProvider({ delayMs: 2 }),
  });
  await registry.refresh();
  app = await startTestApp({ staticDir: dist, provider: registry });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await app?.stop();
  await fake?.close();
});

test('modelo local por defeito, indisponível assinalado, conversa sem API comercial', async () => {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const errors: string[] = [];
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const client = new Client(app.base);
  await client.signup(`local-${randomUUID().slice(0, 6)}@exemplo.pt`);
  const [name, value] = client.cookie.split('=') as [string, string];
  await context.addCookies([{ name, value, url: app.base }]);
  await page.goto(app.base);

  const picker = page.getByRole('button', { name: 'Modelo: Qwen3 4B' });
  await picker.waitFor();
  assert.equal(await page.locator('.topbar__badge').textContent(), 'Modelo local');
  assert.match((await page.locator('.composer-hint').textContent()) ?? '', /Qwen3 4B \(Alibaba \(Qwen\), Apache-2\.0\), a correr na infraestrutura da Forja/);

  await picker.click();
  const offline = page.getByRole('option', { name: /Qwen3\.8 27B/ });
  assert.equal(await offline.getAttribute('aria-disabled'), 'true');
  assert.match((await offline.textContent()) ?? '', /Indisponível.*servidor de modelos não está acessível/s);
  assert.equal(await page.getByRole('option', { name: /Forja Simulador/ }).getAttribute('aria-disabled'), 'false');
  if (shots) await page.screenshot({ path: join(shots, '11-modelos.png') });
  await page.keyboard.press('Escape');

  const box = page.getByRole('textbox', { name: 'Mensagem' });
  await box.fill('Olá modelo local');
  await box.press('Enter');
  await page.locator('article.msg--assistant[data-status="complete"]').waitFor({ timeout: 15_000 });
  assert.match((await page.locator('article.msg--assistant').textContent()) ?? '', /Resposta do modelo de teste para: Olá modelo local/);
  assert.ok(fake.requests.some((r) => r.path === '/api/chat'), 'o pedido foi para o servidor local');
  if (shots) await page.screenshot({ path: join(shots, '12-conversa-local.png') });
  assert.deepEqual(errors, []);
  await context.close();
});
