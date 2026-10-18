/**
 * Testes E2E dos fluxos críticos num Chromium real, contra a aplicação
 * completa (API + PostgreSQL + armazenamento) com o fornecedor simulado.
 * Requer `npm run build`. Capturas de ecrã vão para E2E_SCREENSHOTS, se definido.
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { Client, startTestApp } from '../helpers/test-app.ts';

const dist = fileURLToPath(new URL('../../dist', import.meta.url));
const shots = process.env.E2E_SCREENSHOTS;
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000a0000000a08060000008d32cfbd0000001449444154789c63902d49fb4f0c661855485f85009046c419f4ea39120000000049454e44ae426082', 'hex');

let app: Awaited<ReturnType<typeof startTestApp>>;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let consoleErrors: string[];

before(async () => {
  app = await startTestApp({ staticDir: dist, delayMs: 4 });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await app?.stop();
});

beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.base });
  page = await context.newPage();
  consoleErrors = [];
  page.on('console', (m) => {
    // 401 esperados (sessão inexistente) aparecem como erros de rede na consola.
    if (m.type() === 'error' && !/401 \(Unauthorized\)/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
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

/** Cria uma conta pela API e abre a aplicação já autenticada. */
async function signedIn(email = `e2e-${randomUUID().slice(0, 8)}@exemplo.pt`) {
  const client = new Client(app.base);
  await client.signup(email);
  const [name, value] = client.cookie.split('=') as [string, string];
  await context.addCookies([{ name, value, url: app.base }]);
  await page.goto(app.base);
  await page.getByRole('button', { name: /Modelo: Forja Simulador/ }).waitFor();
  return { client, email };
}

async function send(text: string) {
  const box = page.getByRole('textbox', { name: 'Mensagem' });
  await box.fill(text);
  await box.press('Enter');
}

const lastAssistant = () => page.locator('article.msg--assistant').last();
const history = () => page.getByRole('navigation', { name: 'Histórico de conversas' });

async function waitDone() {
  await page.locator('article.msg--assistant[data-status="streaming"]').waitFor({ state: 'detached', timeout: 15_000 });
}

test('autenticação pela interface: registo, sair, palavra-passe errada, entrar', async () => {
  await page.goto(app.base);
  await page.getByRole('heading', { name: 'Entrar na tua conta' }).waitFor();
  await snap('01-entrar');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await page.getByLabel('Email').fill('maria@exemplo.pt');
  await page.getByLabel('Palavra-passe', { exact: true }).fill('curta');
  assert.equal(await page.getByRole('button', { name: 'Criar conta' }).isDisabled(), true, 'palavra-passe curta bloqueia o envio');
  await page.getByLabel('Palavra-passe', { exact: true }).fill('uma frase longa e segura');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await page.getByRole('button', { name: 'Conta: maria@exemplo.pt' }).waitFor();

  await page.getByRole('button', { name: 'Conta: maria@exemplo.pt' }).click();
  await page.getByRole('menuitem', { name: 'Terminar sessão' }).click();
  await page.getByRole('heading', { name: 'Entrar na tua conta' }).waitFor();

  await page.getByLabel('Email').fill('maria@exemplo.pt');
  await page.getByLabel('Palavra-passe', { exact: true }).fill('errada errada');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('alert').getByText('Email ou palavra-passe incorretos.').waitFor();
  await page.getByLabel('Palavra-passe', { exact: true }).fill('uma frase longa e segura');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('heading', { name: 'Em que vamos trabalhar?' }).waitFor();
});

test('sessão expirada a meio do uso volta ao ecrã de entrada', async () => {
  await signedIn();
  await app.db.query('DELETE FROM sessions');
  await send('olá');
  await page.getByText('A tua sessão terminou.', { exact: false }).waitFor();
});

test('enviar mensagem: streaming, markdown, código, título e histórico no servidor', async () => {
  await signedIn();
  await snap('02-vazio');
  await send('Escreve código em TypeScript');
  await page.getByRole('button', { name: 'Parar geração' }).waitFor();
  await waitDone();
  const reply = lastAssistant();
  assert.match((await reply.textContent()) ?? '', /Resposta simulada/);
  assert.ok((await reply.locator('.code-block .hljs-keyword').count()) > 0, 'código realçado');
  await reply.getByRole('button', { name: 'Copiar código' }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /export function concluir/);
  await history().getByText('Escreve código em TypeScript').waitFor();
  await snap('03-conversa');

  await page.reload();
  await history().getByText('Escreve código em TypeScript').click();
  await lastAssistant().locator('.code-block').waitFor();
  assert.equal(await page.locator('article.msg').count(), 2, 'conversa recarregada do servidor');
});

test('Parar grava o texto parcial; o estado sobrevive a recarregar', async () => {
  await signedIn();
  await send('Resposta longa #lento');
  await lastAssistant().locator('.msg__body').waitFor();
  await page.getByRole('button', { name: 'Parar geração' }).click();
  await lastAssistant().getByText('Geração interrompida.').waitFor();
  await page.waitForTimeout(300);
  await page.reload();
  await history().getByText('Resposta longa #lento').click();
  await lastAssistant().getByText('Geração interrompida.').waitFor();
});

test('erro do fornecedor e Repetir (regeneração no servidor)', async () => {
  await signedIn();
  await send('Falha #erro');
  const alert = page.getByRole('alert');
  await alert.waitFor();
  assert.match((await alert.textContent()) ?? '', /provider_unavailable/);
  await alert.getByRole('button', { name: 'Repetir' }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('article.msg--assistant').count(), 1);
});

test('conteúdo perigoso nas respostas é mostrado como texto', async () => {
  await signedIn();
  await send('<img src=x onerror="window.__xss=1"> [clica](javascript:window.__xss=2) <script>window.__xss=3</script>');
  await waitDone();
  assert.equal(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss), undefined);
  assert.equal(await page.locator('.msg__body img').count(), 0);
  assert.equal(await page.locator('a[href^="javascript"]').count(), 0);
});

test('pesquisa no servidor (conteúdo, sem acentos), mudar o nome e eliminar', async () => {
  await signedIn();
  await send('Primeira conversa sobre arquitetura');
  await waitDone();
  await page.getByRole('button', { name: 'Nova conversa', exact: true }).click();
  await send('Segunda conversa sobre segurança');
  await waitDone();

  const search = page.getByRole('searchbox', { name: 'Pesquisar conversas' });
  await search.fill('seguranca');
  await history().getByText('Segunda conversa sobre segurança').waitFor();
  assert.equal(await history().getByRole('listitem').count(), 1);
  await search.fill('Resposta simulada'); // só existe no conteúdo das respostas
  await page.waitForFunction(() => document.querySelectorAll('nav[aria-label="Histórico de conversas"] li').length === 2);
  await search.fill('nada disto');
  await page.getByText('Nada encontrado para “nada disto”.').waitFor();
  await search.fill('');

  await history().getByRole('button', { name: /Opções de “Primeira/ }).click();
  await page.getByRole('menuitem', { name: 'Mudar o nome' }).click();
  const rename = page.getByRole('textbox', { name: 'Novo título' });
  await rename.fill('Arquitetura v1');
  await rename.press('Enter');
  await history().getByText('Arquitetura v1').waitFor();

  await history().getByRole('button', { name: /Opções de “Arquitetura v1/ }).click();
  await page.getByRole('menuitem', { name: 'Eliminar' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Eliminar' }).click();
  await page.waitForTimeout(200);
  await page.reload();
  await history().getByText('Segunda conversa sobre segurança').waitFor();
  assert.equal(await history().getByText('Arquitetura v1').count(), 0);
});

test('anexos: envio com progresso, imagem com miniatura, tipo inválido recusado', async () => {
  await signedIn();
  const dir = await mkdtemp(join(tmpdir(), 'forja-e2e-'));
  const textFile = join(dir, 'notas.md');
  const imageFile = join(dir, 'diagrama.png');
  const exeFile = join(dir, 'programa.exe');
  await writeFile(textFile, '# Notas\nconteúdo');
  await writeFile(imageFile, PNG);
  await writeFile(exeFile, Buffer.from([0x4d, 0x5a, 0x90, 0]));
  await page.locator('input[type=file]').setInputFiles([textFile, imageFile, exeFile]);
  const files = page.getByRole('list', { name: 'Anexos a enviar' });
  await files.getByText('Tipo não suportado', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Remover programa.exe' }).click();
  await page.waitForFunction(() => !document.querySelector('.file-chip--uploading'));
  assert.equal(await files.locator('.file-chip--ready').count(), 2);
  await snap('04-anexos');
  await send('Lê os anexos');
  await waitDone();
  const text = (await lastAssistant().textContent()) ?? '';
  assert.match(text, /notas\.md/);
  assert.match(text, /diagrama\.png/);
  const thumb = page.locator('.msg--user .file-thumb img');
  await thumb.waitFor();
  assert.ok(await thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 10), 'miniatura carregada do servidor');
  await snap('05-anexos-enviados');
});

test('importação do histórico guardado no navegador pela Fase 2', async () => {
  await context.addInitScript(() => {
    localStorage.setItem(
      'forja.conversations.v1',
      JSON.stringify([
        { id: 'x', title: 'Conversa antiga do navegador', model: 'forja-sim', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, messages: [
          { id: 'm', role: 'user', content: 'pergunta antiga', createdAt: 1_700_000_000_000, status: 'complete' },
          { id: 'n', role: 'assistant', content: 'resposta antiga', createdAt: 1_700_000_000_001, status: 'complete' },
        ] },
      ]),
    );
  });
  await signedIn();
  const offer = page.getByRole('region', { name: 'Importar histórico' });
  await offer.waitFor();
  await snap('06-importar');
  await offer.getByRole('button', { name: 'Importar', exact: true }).click();
  await history().getByText('Conversa antiga do navegador').waitFor();
  assert.equal(await offer.count(), 0);
  await history().getByText('Conversa antiga do navegador').click();
  await page.getByText('resposta antiga').waitFor();
});

test('tema escuro aplicado e preservado', async () => {
  await signedIn();
  await page.getByRole('radio', { name: 'Escuro' }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await send('Escreve código');
  await waitDone();
  await snap('07-escuro');
  await page.reload();
  await page.getByRole('button', { name: /Modelo:/ }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.getByRole('radio', { name: 'Sistema' }).click();
});

test('barra lateral recolhe em desktop e é gaveta em telemóvel', async () => {
  await signedIn();
  await page.getByRole('button', { name: 'Recolher barra lateral' }).click();
  assert.equal(await page.locator('aside.sidebar').count(), 0);
  await page.getByRole('button', { name: 'Expandir barra lateral' }).click();
  await page.locator('aside.sidebar').waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  await page.locator('aside.sidebar').waitFor();
  assert.equal(await page.locator('main').getAttribute('inert'), '');
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('aside.sidebar')), true, 'foco dentro da gaveta');
  await snap('08-movel-gaveta');
  await page.keyboard.press('Escape');
  await page.locator('aside.sidebar').waitFor({ state: 'detached' });
  await send('Mostra uma tabela');
  await waitDone();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await snap('09-movel-conversa');
});

test('ecrã de entrada em telemóvel', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.base);
  await page.getByRole('heading', { name: 'Entrar na tua conta' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await snap('10-movel-entrar');
});
