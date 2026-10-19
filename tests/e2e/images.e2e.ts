/** E2E da criação de imagens pela interface, com um servidor de imagens falso. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { parseCatalog } from '../../server/providers/catalog.ts';
import { createImageGenerator } from '../../server/providers/images.ts';
import { startFakeImageServer } from '../helpers/fake-image-server.ts';
import { Client, startTestApp } from '../helpers/test-app.ts';

const dist = fileURLToPath(new URL('../../dist', import.meta.url));
let fake: Awaited<ReturnType<typeof startFakeImageServer>>;
let app: Awaited<ReturnType<typeof startTestApp>>;
let bare: Awaited<ReturnType<typeof startTestApp>>;
let browser: Browser;

before(async () => {
  fake = await startFakeImageServer();
  const cfg = parseCatalog({ images: { baseUrl: fake.url, hosting: 'self-hosted', model: 'sd-teste' } }).images!;
  app = await startTestApp({ staticDir: dist, images: createImageGenerator(cfg) });
  bare = await startTestApp({ staticDir: dist });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await app?.stop();
  await bare?.stop();
  await fake?.stop();
});

async function open(base: string, email: string) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const client = new Client(base);
  await client.signup(email);
  const [name, value] = client.cookie.split('=') as [string, string];
  await context.addCookies([{ name, value, url: base }]);
  const page = await context.newPage();
  await page.goto(base);
  await page.getByRole('button', { name: /Modelo: Forja Simulador/ }).waitFor();
  return { context, page };
}

test('criar imagem: botão, pedido e imagem na conversa', async () => {
  const { context, page } = await open(app.base, 'img-e2e@exemplo.pt');
  try {
    await page.getByRole('button', { name: /Criar imagem/ }).click();
    const box = page.getByRole('textbox', { name: 'Mensagem' });
    await box.fill('uma casa azul numa colina');
    await box.press('Enter');
    const img = page.locator('article.msg--assistant img');
    await img.waitFor({ timeout: 15_000 });
    assert.equal(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), true, 'a imagem carrega');
    await page.getByText('uma casa azul numa colina').first().waitFor();
    assert.equal(fake.requests.at(-1)?.body.prompt, 'uma casa azul numa colina');
  } finally { await context.close(); }
});

test('sem servidor de imagens configurado o botão não aparece', async () => {
  const { context, page } = await open(bare.base, 'sem-img-e2e@exemplo.pt');
  try {
    assert.equal(await page.getByRole('button', { name: /Criar imagem/ }).count(), 0);
  } finally { await context.close(); }
});
