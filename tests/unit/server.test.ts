import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk } from '../../server/providers/mock.ts';
import { trimHistory } from '../../server/context.ts';
import { createRateLimiter } from '../../server/rate-limit.ts';
import { classify, cleanFileName } from '../../server/storage/sniff.ts';
import { HttpError, Router, contentDisposition, parseCookies, serializeCookie, uuidParam } from '../../server/http/http.ts';
import { hashPassword, needsRehash, verifyPassword } from '../../server/security/password.ts';
import { likePattern } from '../../server/modules/conversations.ts';
import { loadConfig } from '../../server/config.ts';

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

test('classificação de ficheiros pelo conteúdo', () => {
  const ok = (b: Buffer) => {
    const r = classify(b);
    return r.ok ? r.detected.mediaType : r.code;
  };
  assert.equal(ok(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])), 'image/png');
  assert.equal(ok(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(ok(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(ok(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp');
  assert.equal(ok(Buffer.from('%PDF-1.7\n')), 'application/pdf');
  assert.equal(ok(Buffer.from('<svg onload="x()"></svg>')), 'text/plain; charset=utf-8', 'SVG é tratado como texto');
  assert.equal(ok(Buffer.from([0xc3, 0x28])), 'unsupported_type', 'UTF-8 inválido');
  assert.equal(ok(Buffer.from('abc\u0000def')), 'unsupported_type');
  assert.equal(ok(Buffer.alloc(0)), 'empty_file');
  assert.equal(cleanFileName('..%2F..%2Fetc%2Fpasswd'), '.._.._etc_passwd');
  assert.equal(cleanFileName(undefined), 'ficheiro');
  assert.equal(cleanFileName('%E0%A4%A'), '%E0%A4%A');
});

test('cookies e Content-Disposition', () => {
  assert.deepEqual(parseCookies('a=1; b=x%20y; a=2; ruido'), { a: '1', b: 'x y' });
  const c = serializeCookie('s', 'v', { secure: true, maxAgeSeconds: 10 });
  assert.equal(c, 's=v; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=10');
  assert.equal(contentDisposition('attachment', 'relatório "final".pdf'), `attachment; filename="relat_rio _final_.pdf"; filename*=UTF-8''relat%C3%B3rio%20%22final%22.pdf`);
});

test('router: parâmetros, 405 e 404', () => {
  const r = new Router<null>();
  r.add('GET', '/api/x/:id', () => {}, { auth: true });
  const m = r.match('GET', '/api/x/abc');
  assert.ok(m && m !== 'method-not-allowed');
  assert.deepEqual(m.params, { id: 'abc' });
  assert.equal(r.match('POST', '/api/x/abc'), 'method-not-allowed');
  assert.equal(r.match('GET', '/api/x/abc/y'), null);
  assert.throws(() => uuidParam("1' OR '1'='1"), HttpError);
  assert.equal(uuidParam('0D3B6A4E-1C2B-4F6A-9B8C-0123456789AB'), '0d3b6a4e-1c2b-4f6a-9b8c-0123456789ab');
});

test('hash de palavras-passe: verificação, unicidade e re-hash', async () => {
  const h1 = await hashPassword('correto-cavalo-bateria', 12);
  const h2 = await hashPassword('correto-cavalo-bateria', 12);
  assert.notEqual(h1, h2, 'salt aleatório');
  assert.equal(await verifyPassword('correto-cavalo-bateria', h1), true);
  assert.equal(await verifyPassword('correto-cavalo-bateri', h1), false);
  assert.equal(await verifyPassword('x', 'formato-invalido'), false);
  assert.equal(needsRehash(h1, 17), true);
  assert.equal(needsRehash(h1, 12), false);
});

test('LIKE: curingas do utilizador são escapados', () => {
  assert.equal(likePattern('50%_a\\b'), '%50\\%\\_a\\\\b%');
});

test('configuração: falha cedo e regras de produção', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
  const base = { DATABASE_URL: 'postgres://u:p@h:5432/d' };
  assert.equal(loadConfig(base).cookieSecure, false);
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }), /PUBLIC_ORIGIN/);
  const prod = loadConfig({ ...base, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://forja.exemplo', MODELS_CONFIG: 'config/models.json' });
  assert.equal(prod.cookieSecure, true);
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://f.x', MODELS_CONFIG: 'm.json', SCRYPT_LOG_N: '12' }), /SCRYPT/);
});
