/**
 * Testes E2E dos fluxos críticos, num Chromium real, contra o servidor com o
 * fornecedor simulado. Requer `npm run build` (o script test:e2e faz isso).
 * Capturas de ecrã vão para E2E_SCREENSHOTS, se definido.
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createApp } from '../../server/app.ts';
import { createMockProvider } from '../../server/providers/mock.ts';

const dist = fileURLToPath(new URL('../../dist', import.meta.url));
const shots = process.env.E2E_SCREENSHOTS;

let server: Server;
let base: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let consoleErrors: string[];

before(async () => {
  server = createApp({ provider: createMockProvider({ delayMs: 4 }), staticDir: dist, chatPerMinute: 1000 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  page = await context.newPage();
  consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto(base);
  await page.getByRole('button', { name: /Modelo: Forja Simulador/ }).waitFor();
});

afterEach(async () => {
  await context.close();
  assert.deepEqual(consoleErrors, [], 'sem erros na consola');
});

async function snap(name: string) {
  if (!shots) return;
  await page.waitForTimeout(350); // deixa terminar as animações de entrada
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function send(text: string) {
  const box = page.getByRole('textbox', { name: 'Mensagem' });
  await box.fill(text);
  await box.press('Enter');
}

const lastAssistant = () => page.locator('article.msg--assistant').last();

async function waitDone() {
  await page.locator('article.msg--assistant[data-status="streaming"]').waitFor({ state: 'detached', timeout: 15_000 });
}

test('estado vazio e seletor de modelo distinguem simulado de pendente', async () => {
  await page.getByRole('heading', { name: 'Em que vamos trabalhar?' }).waitFor();
  await snap('01-vazio-claro');
  await page.getByRole('button', { name: /Modelo: Forja Simulador/ }).click();
  const options = page.getByRole('option');
  assert.equal(await options.count(), 3);
  assert.equal(await page.getByRole('option', { name: /Claude/ }).getAttribute('aria-disabled'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await options.count(), 0);
});

test('enviar mensagem: streaming, markdown, código e histórico', async () => {
  await send('Escreve código em TypeScript');
  await lastAssistant().locator('.thinking, .msg__body').first().waitFor();
  await page.getByRole('button', { name: 'Parar geração' }).waitFor();
  await waitDone();
  const reply = lastAssistant();
  assert.match((await reply.textContent()) ?? '', /Resposta simulada/);
  assert.ok((await reply.locator('.code-block .hljs-keyword').count()) > 0, 'código realçado');
  assert.equal(await reply.locator('.code-block__lang').textContent(), 'typescript');
  await reply.getByRole('button', { name: 'Copiar código' }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /export function concluir/);
  assert.equal(await page.getByRole('button', { name: 'Enviar mensagem' }).isDisabled(), true);
  const history = page.getByRole('navigation', { name: 'Histórico de conversas' });
  assert.match((await history.textContent()) ?? '', /Escreve código em TypeScript/);
  assert.equal(await page.locator('.topbar__title').textContent(), 'Escreve código em TypeScript');
  await snap('02-conversa-codigo');
});

test('tabela renderizada a partir de markdown GFM', async () => {
  await send('Mostra uma tabela');
  await waitDone();
  assert.equal(await lastAssistant().locator('table th').count(), 3);
  assert.equal(await lastAssistant().locator('tbody tr').count(), 3);
});

test('Parar mantém o texto parcial e marca a interrupção', async () => {
  await send('Resposta longa #lento');
  await lastAssistant().locator('.msg__body').waitFor();
  await page.getByRole('button', { name: 'Parar geração' }).click();
  await lastAssistant().getByText('Geração interrompida.').waitFor();
  assert.equal(await lastAssistant().getAttribute('data-status'), 'cancelled');
  assert.ok(((await lastAssistant().locator('.msg__body').textContent()) ?? '').length > 0);
  await page.getByRole('button', { name: 'Enviar mensagem' }).waitFor();
});

test('erro do fornecedor mostra alerta e permite repetir', async () => {
  await send('Falha #erro');
  const alert = page.getByRole('alert');
  await alert.waitFor();
  assert.match((await alert.textContent()) ?? '', /provider_unavailable/);
  await snap('03-erro');
  await alert.getByRole('button', { name: 'Repetir' }).click();
  await page.getByRole('alert').waitFor();
  // A repetição substitui a resposta falhada em vez de acrescentar outra.
  assert.equal(await page.locator('article.msg--assistant').count(), 1);
});

test('conteúdo perigoso nas respostas é mostrado como texto', async () => {
  await send('<img src=x onerror="window.__xss=1"> [clica](javascript:window.__xss=2) <script>window.__xss=3</script>');
  await waitDone();
  const xss = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss);
  assert.equal(xss, undefined);
  assert.equal(await page.locator('.msg__body img').count(), 0);
  assert.equal(await page.locator('a[href^="javascript"]').count(), 0);
});

test('histórico persiste, pesquisa, renomeia e elimina', async () => {
  await send('Primeira conversa sobre arquitetura');
  await waitDone();
  await page.getByRole('button', { name: 'Nova conversa', exact: true }).click();
  await send('Segunda conversa sobre segurança');
  await waitDone();

  await page.reload();
  const history = page.getByRole('navigation', { name: 'Histórico de conversas' });
  await history.getByText('Primeira conversa sobre arquitetura').waitFor();
  assert.equal(await history.getByRole('listitem').count(), 2);

  const search = page.getByRole('searchbox', { name: 'Pesquisar conversas' });
  await search.fill('seguranca'); // sem acento: a pesquisa ignora acentos
  assert.equal(await history.getByRole('listitem').count(), 1);
  await search.fill('nada disto');
  await page.getByText('Nada encontrado para “nada disto”.').waitFor();
  await search.fill('');

  await history.getByRole('button', { name: /Opções de “Primeira/ }).click();
  await page.getByRole('menuitem', { name: 'Mudar o nome' }).click();
  const rename = page.getByRole('textbox', { name: 'Novo título' });
  await rename.fill('Arquitetura v1');
  await rename.press('Enter');
  await history.getByText('Arquitetura v1').waitFor();

  await history.getByRole('button', { name: /Opções de “Arquitetura v1/ }).click();
  await page.getByRole('menuitem', { name: 'Eliminar' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Eliminar' }).click();
  await page.reload();
  await history.getByText('Segunda conversa sobre segurança').waitFor();
  assert.equal(await history.getByText('Arquitetura v1').count(), 0);
});

test('anexos: ficheiro de texto aceite e enviado; imagem rejeitada', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forja-e2e-'));
  const textFile = join(dir, 'notas.md');
  const imageFile = join(dir, 'foto.png');
  await writeFile(textFile, '# Notas\nconteúdo');
  await writeFile(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  await page.locator('input[type=file]').setInputFiles([textFile, imageFile]);
  const files = page.getByRole('list', { name: 'Anexos a enviar' });
  await files.getByText('Só ficheiros de texto nesta fase', { exact: false }).waitFor();
  await files.getByText('notas.md').waitFor();
  await page.getByRole('button', { name: 'Remover foto.png' }).click();
  await snap('04-anexos');
  await send('Lê o anexo');
  await waitDone();
  assert.match((await lastAssistant().textContent()) ?? '', /notas\.md/);
  assert.equal(await page.getByRole('list', { name: 'Anexos' }).getByText('notas.md').count(), 1);
});

test('tema escuro aplicado e preservado', async () => {
  await page.getByRole('radio', { name: 'Escuro' }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await send('Escreve código');
  await waitDone();
  await snap('05-conversa-escuro');
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.getByRole('radio', { name: 'Sistema' }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), null);
});

test('barra lateral recolhe em desktop e é gaveta em telemóvel', async () => {
  await page.getByRole('button', { name: 'Recolher barra lateral' }).click();
  assert.equal(await page.locator('aside.sidebar').count(), 0);
  await page.getByRole('button', { name: 'Expandir barra lateral' }).click();
  await page.locator('aside.sidebar').waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Abrir menu' }).waitFor();
  assert.equal(await page.locator('aside.sidebar').count(), 0);
  await snap('06-movel-vazio');
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  await page.locator('aside.sidebar').waitFor();
  assert.equal(await page.locator('main').getAttribute('inert'), '');
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('aside.sidebar')), true, 'foco dentro da gaveta');
  await snap('07-movel-gaveta');
  await page.keyboard.press('Escape');
  await page.locator('aside.sidebar').waitFor({ state: 'detached' });
  await send('Mostra uma tabela');
  await waitDone();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'sem scroll horizontal na página');
  await snap('08-movel-conversa');
});

test('navegação por teclado: Shift+Enter quebra linha e Enter envia', async () => {
  const box = page.getByRole('textbox', { name: 'Mensagem' });
  await box.focus();
  await page.keyboard.type('linha 1');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('linha 2');
  assert.equal(await box.inputValue(), 'linha 1\nlinha 2');
  await page.keyboard.press('Enter');
  await waitDone();
  assert.equal(await box.inputValue(), '');
  assert.equal(await page.locator('.msg--user .msg__text').textContent(), 'linha 1\nlinha 2');
});
