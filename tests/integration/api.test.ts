import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runMaintenance } from '../../server/modules/maintenance.ts';
import { Client, parseSse, startTestApp } from '../helpers/test-app.ts';

let app: Awaited<ReturnType<typeof startTestApp>>;
before(async () => {
  app = await startTestApp();
});
after(async () => app?.stop());

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0def46b80000000049454e44ae426082', 'hex');

async function newUser(email = `u-${randomUUID().slice(0, 8)}@exemplo.pt`) {
  const c = new Client(app.base);
  await c.signup(email);
  return c;
}

async function newConversation(c: Client) {
  const id = randomUUID();
  const r = await c.json('POST', '/api/conversations', { id, model: 'forja-sim' });
  assert.equal(r.status, 201);
  return id;
}

async function send(c: Client, conversationId: string, content: string, fileIds: string[] = []) {
  const userId = randomUUID();
  const assistantId = randomUUID();
  const res = await c.request('POST', `/api/conversations/${conversationId}/messages`, {
    mode: 'send',
    model: 'forja-sim',
    userMessage: { id: userId, content, fileIds },
    assistantMessageId: assistantId,
  });
  const text = await res.text();
  return { status: res.status, events: res.ok ? parseSse(text) : [], body: res.ok ? null : JSON.parse(text), userId, assistantId };
}

async function detail(c: Client, id: string) {
  const r = await c.json<{ conversation: { title: string; messages: { id: string; role: string; status: string; content: string; files: { id: string; name: string }[] }[] } }>('GET', `/api/conversations/${id}`);
  assert.equal(r.status, 200);
  return r.body.conversation;
}

describe('autenticação', () => {
  test('registo, sessão, me e terminar sessão', async () => {
    const c = new Client(app.base);
    const r = await c.json<{ user: { email: string } }>('POST', '/api/auth/signup', { email: ' Ana@Exemplo.PT ', password: 'uma-frase-longa-segura' });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.email, 'ana@exemplo.pt');
    assert.match(r.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Lax/);
    assert.equal((await c.json('GET', '/api/auth/me')).status, 200);

    const stolen = c.cookie;
    assert.equal((await c.request('POST', '/api/auth/logout')).status, 204);
    const replay = new Client(app.base);
    replay.cookie = stolen;
    assert.equal((await replay.json('GET', '/api/auth/me')).status, 401, 'token antigo deixou de valer');
  });

  test('o token não é guardado em claro na base de dados', async () => {
    const c = await newUser();
    const token = decodeURIComponent(c.cookie.split('=')[1]!);
    const r = await app.db.query<{ n: number }>("SELECT count(*)::int AS n FROM sessions WHERE encode(token_hash, 'escape') LIKE $1", [`%${token}%`]);
    assert.equal(r.rows[0]!.n, 0);
  });

  test('validações de registo', async () => {
    const c = new Client(app.base);
    assert.equal((await c.json('POST', '/api/auth/signup', { email: 'x@y.pt', password: 'curta' })).status, 422);
    assert.equal((await c.json('POST', '/api/auth/signup', { email: 'nao-email', password: 'uma-frase-longa-segura' })).status, 422);
    assert.equal((await c.json('POST', '/api/auth/signup', { email: 'joaquim@y.pt', password: 'joaquim-1234567' })).status, 422);
    await newUser('dup@exemplo.pt');
    assert.equal((await new Client(app.base).json('POST', '/api/auth/signup', { email: 'DUP@exemplo.pt', password: 'outra-frase-longa' })).status, 409);
  });

  test('login: credenciais erradas e corretas, sem distinguir conta inexistente', async () => {
    await newUser('login@exemplo.pt');
    const c = new Client(app.base);
    const wrong = await c.json<{ error: { message: string } }>('POST', '/api/auth/login', { email: 'login@exemplo.pt', password: 'errada-errada' });
    const missing = await c.json<{ error: { message: string } }>('POST', '/api/auth/login', { email: 'ninguem@exemplo.pt', password: 'errada-errada' });
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(wrong.body.error.message, missing.body.error.message);
    const ok = await c.json('POST', '/api/auth/login', { email: 'LOGIN@exemplo.pt', password: 'palavra-passe-segura-1' });
    assert.equal(ok.status, 200);
    assert.equal((await c.json('GET', '/api/auth/me')).status, 200);
  });

  test('limite de tentativas por conta', async () => {
    await newUser('alvo@exemplo.pt');
    const c = new Client(app.base);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await c.json('POST', '/api/auth/login', { email: 'alvo@exemplo.pt', password: `tentativa-${i}` })).status);
    }
    assert.ok(statuses.includes(429), `esperado 429 em ${statuses}`);
  });

  test('rotas protegidas exigem sessão', async () => {
    const c = new Client(app.base);
    for (const [m, p] of [['GET', '/api/conversations'], ['GET', '/api/models'], ['POST', '/api/files']] as const) {
      assert.equal((await c.request(m, p, m === 'POST' ? Buffer.from('x') : undefined)).status, 401, `${m} ${p}`);
    }
  });

  test('CSRF: pedidos de outra origem ou sem origem são recusados', async () => {
    const c = await newUser();
    const id = randomUUID();
    const evil = await c.request('POST', '/api/conversations', { id, model: 'forja-sim' }, { Origin: 'https://atacante.exemplo' });
    assert.equal(evil.status, 403);
    const res = await fetch(`${app.base}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: c.cookie },
      body: JSON.stringify({ id, model: 'forja-sim' }),
    });
    assert.equal(res.status, 403);
  });
});

describe('conversas e streaming persistido', () => {
  test('enviar: SSE completo, gravado, título derivado e histórico lido do servidor', async () => {
    const c = await newUser();
    const id = await newConversation(c);
    const first = await send(c, id, 'Explica arquitetura modular\ncom detalhe');
    assert.equal(first.status, 200);
    assert.deepEqual([first.events[0]?.type, first.events.at(-1)?.type], ['message.start', 'message.end']);
    const streamed = first.events.filter((e) => e.type === 'delta').map((e) => e.data.text).join('');

    const conv = await detail(c, id);
    assert.equal(conv.title, 'Explica arquitetura modular');
    assert.deepEqual(conv.messages.map((m) => [m.role, m.status]), [['user', 'complete'], ['assistant', 'complete']]);
    assert.equal(conv.messages[1]!.content, streamed);

    const second = await send(c, id, 'E depois?');
    const text = second.events.filter((e) => e.type === 'delta').map((e) => e.data.text).join('');
    assert.match(text, /turno 2/, 'o servidor usou o histórico gravado');
  });

  test('uma geração de cada vez por conversa', async () => {
    const c = await newUser();
    const id = await newConversation(c);
    const slow = c.request('POST', `/api/conversations/${id}/messages`, {
      mode: 'send', model: 'forja-sim', userMessage: { id: randomUUID(), content: 'longo #lento', fileIds: [] }, assistantMessageId: randomUUID(),
    });
    const firstRes = await slow;
    const reader = firstRes.body!.getReader();
    await reader.read();
    const second = await send(c, id, 'outra');
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'generation_in_progress');
    await reader.cancel();
  });

  test('cancelar a meio grava o texto parcial como cancelado', async () => {
    const c = await newUser();
    const id = await newConversation(c);
    const assistantId = randomUUID();
    const controller = new AbortController();
    const res = await fetch(`${app.base}/api/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: app.base, Cookie: c.cookie },
      body: JSON.stringify({ mode: 'send', model: 'forja-sim', userMessage: { id: randomUUID(), content: '#lento', fileIds: [] }, assistantMessageId: assistantId }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    controller.abort();
    let msg: { status: string; content: string } | undefined;
    for (let i = 0; i < 50; i++) {
      msg = (await detail(c, id)).messages.find((m) => m.id === assistantId);
      if (msg?.status !== 'streaming') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(msg?.status, 'cancelled');
    assert.ok(msg!.content.length > 0);
  });

  test('erro do fornecedor fica gravado; regenerar substitui a última resposta', async () => {
    const c = await newUser();
    const id = await newConversation(c);
    const r = await send(c, id, 'falha #erro');
    assert.equal(r.events.at(-1)?.type, 'error');
    let conv = await detail(c, id);
    assert.equal(conv.messages[1]!.status, 'error');

    const newAssistant = randomUUID();
    const regen = await c.request('POST', `/api/conversations/${id}/messages`, {
      mode: 'regenerate', model: 'forja-sim', fromMessageId: r.assistantId, assistantMessageId: newAssistant,
    });
    assert.equal(regen.status, 200);
    await regen.text();
    conv = await detail(c, id);
    assert.deepEqual(conv.messages.map((m) => m.id), [r.userId, newAssistant]);

    const stale = await c.json('POST', `/api/conversations/${id}/messages`, {
      mode: 'regenerate', model: 'forja-sim', fromMessageId: r.userId, assistantMessageId: randomUUID(),
    });
    assert.equal(stale.status, 409);
  });

  test('ids repetidos e modelos por integrar são recusados', async () => {
    const c = await newUser();
    const id = await newConversation(c);
    const r = await send(c, id, 'olá');
    const dup = await c.json('POST', `/api/conversations/${id}/messages`, {
      mode: 'send', model: 'forja-sim', userMessage: { id: r.userId, content: 'x', fileIds: [] }, assistantMessageId: randomUUID(),
    });
    assert.equal(dup.status, 409);
    const pending = await c.json('POST', `/api/conversations/${id}/messages`, {
      mode: 'send', model: 'anthropic', userMessage: { id: randomUUID(), content: 'x', fileIds: [] }, assistantMessageId: randomUUID(),
    });
    assert.equal(pending.status, 409);
  });

  test('mudar o nome, pesquisa sem acentos, curingas literais e paginação', async () => {
    const c = await newUser();
    const a = await newConversation(c);
    await send(c, a, 'Configuração do servidor');
    const b = await newConversation(c);
    await send(c, b, 'Outra coisa');
    assert.equal((await c.json('PATCH', `/api/conversations/${b}`, { title: 'Plano 100%' })).status, 200);

    const list = async (q: string) =>
      (await c.json<{ conversations: { id: string }[] }>('GET', `/api/conversations?q=${encodeURIComponent(q)}`)).body.conversations.map((x) => x.id);
    assert.deepEqual(await list('configuracao'), [a]);
    assert.deepEqual(await list('SERVIDOR'), [a]);
    assert.deepEqual(await list('100%'), [b]);
    assert.deepEqual(await list('%'), [b], '% é literal, não curinga');

    const imported = await c.json('POST', '/api/import/local', {
      conversations: Array.from({ length: 105 }, (_, i) => ({ title: `Antiga ${i}`, model: 'forja-sim', createdAt: 1_600_000_000_000 + i, updatedAt: 1_600_000_000_000 + i, messages: [] })),
    });
    assert.equal(imported.status, 201);
    const page1 = await c.json<{ conversations: { id: string }[]; nextCursor: string }>('GET', '/api/conversations');
    assert.equal(page1.body.conversations.length, 100);
    assert.ok(page1.body.nextCursor);
    const page2 = await c.json<{ conversations: { id: string }[]; nextCursor: string | null }>('GET', `/api/conversations?cursor=${encodeURIComponent(page1.body.nextCursor)}`);
    assert.equal(page2.body.conversations.length, 7);
    assert.equal(page2.body.nextCursor, null);
    const ids = new Set([...page1.body.conversations, ...page2.body.conversations].map((x) => x.id));
    assert.equal(ids.size, 107);
  });
});

describe('ficheiros', () => {
  test('upload de texto e imagem, anexar, ler e controlo de tipo', async () => {
    const c = await newUser();
    const txt = await c.json<{ file: { id: string; kind: string; mediaType: string } }>('POST', '/api/files', Buffer.from('# Notas\nconteúdo'));
    assert.equal(txt.status, 201);
    assert.equal(txt.body.file.kind, 'text');

    const png = await c.request('POST', '/api/files', PNG, { 'X-File-Name': encodeURIComponent('diagrama ç.png'), 'Content-Type': 'text/plain' });
    const pngBody = (await png.json()) as { file: { id: string; kind: string; mediaType: string; name: string } };
    assert.equal(pngBody.file.kind, 'image');
    assert.equal(pngBody.file.mediaType, 'image/png', 'tipo detetado pelos bytes, não pelo cabeçalho');
    assert.equal(pngBody.file.name, 'diagrama ç.png');

    const exe = await c.request('POST', '/api/files', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0xff, 0xfe]));
    assert.equal(exe.status, 415);
    const big = await c.request('POST', '/api/files', Buffer.alloc(1024 * 1024 + 10, 0x61));
    assert.equal(big.status, 413);

    const id = await newConversation(c);
    const r = await send(c, id, 'Lê isto', [txt.body.file.id, pngBody.file.id]);
    const text = r.events.filter((e) => e.type === 'delta').map((e) => e.data.text).join('');
    assert.match(text, /diagrama ç\.png/);
    assert.match(text, /requer modelo multimodal/);
    const conv = await detail(c, id);
    assert.equal(conv.messages[0]!.files.length, 2);

    const reuse = await send(c, id, 'outra vez', [txt.body.file.id]);
    assert.equal(reuse.status, 422, 'um ficheiro só pode ser anexado uma vez');

    const content = await c.request('GET', `/api/files/${pngBody.file.id}/content`);
    assert.equal(content.headers.get('content-type'), 'image/png');
    assert.match(content.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), PNG);
    const txtContent = await c.request('GET', `/api/files/${txt.body.file.id}/content`);
    assert.match(txtContent.headers.get('content-disposition') ?? '', /^attachment/);
    assert.equal((await c.request('DELETE', `/api/files/${txt.body.file.id}`)).status, 404, 'anexados não se apagam sozinhos');
  });

  test('eliminar a conversa apaga os ficheiros do disco', async () => {
    const c = await newUser();
    const up = await c.json<{ file: { id: string } }>('POST', '/api/files', Buffer.from('segredo'));
    const id = await newConversation(c);
    await send(c, id, 'anexo', [up.body.file.id]);
    const countBlobs = async () => {
      let n = 0;
      for (const d of await readdir(app.storageDir)) {
        if (!d.startsWith('.')) n += (await readdir(join(app.storageDir, d))).length;
      }
      return n;
    };
    const before = await countBlobs();
    assert.equal((await c.request('DELETE', `/api/conversations/${id}`)).status, 204);
    assert.equal(await countBlobs(), before - 1);
    assert.equal((await c.request('GET', `/api/files/${up.body.file.id}/content`)).status, 404);
  });
});

describe('isolamento entre utilizadores', () => {
  test('outro utilizador não vê, altera, apaga nem usa recursos alheios', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const conv = await newConversation(alice);
    const r = await send(alice, conv, 'privado');
    const file = await alice.json<{ file: { id: string } }>('POST', '/api/files', Buffer.from('confidencial'));

    assert.equal((await bob.json('GET', `/api/conversations/${conv}`)).status, 404);
    assert.equal((await bob.json('PATCH', `/api/conversations/${conv}`, { title: 'hack' })).status, 404);
    assert.equal((await bob.request('DELETE', `/api/conversations/${conv}`)).status, 404);
    assert.equal((await send(bob, conv, 'intruso')).status, 404);
    const regen = await bob.json('POST', `/api/conversations/${conv}/messages`, {
      mode: 'regenerate', model: 'forja-sim', fromMessageId: r.assistantId, assistantMessageId: randomUUID(),
    });
    assert.equal(regen.status, 404);
    assert.equal((await bob.request('GET', `/api/files/${file.body.file.id}/content`)).status, 404);
    assert.equal((await bob.request('DELETE', `/api/files/${file.body.file.id}`)).status, 404);
    const bobConv = await newConversation(bob);
    assert.equal((await send(bob, bobConv, 'roubar anexo', [file.body.file.id])).status, 422);
    assert.deepEqual((await bob.json<{ conversations: unknown[] }>('GET', '/api/conversations?q=privado')).body.conversations, []);
    // Reutilizar o id de uma conversa alheia não a revela nem a sobrepõe.
    assert.equal((await bob.json('POST', '/api/conversations', { id: conv, model: 'forja-sim' })).status, 409);
    assert.equal((await detail(alice, conv)).title, 'privado');
  });
});

describe('importação e manutenção', () => {
  test('importa o histórico do navegador com anexos, numa transação', async () => {
    const c = await newUser();
    const r = await c.json<{ imported: { conversations: number; messages: number; files: number } }>('POST', '/api/import/local', {
      conversations: [{
        title: 'Do navegador', model: 'forja-sim', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000,
        messages: [
          { role: 'user', content: 'pergunta', createdAt: 1_700_000_000_000, status: 'complete', attachments: [{ name: 'a.md', mediaType: 'text/markdown', content: '# a' }] },
          { role: 'assistant', content: 'resposta parcial', createdAt: 1_700_000_050_000, status: 'streaming' },
        ],
      }],
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.imported, { conversations: 1, messages: 2, files: 1 });
    const list = await c.json<{ conversations: { id: string; title: string }[] }>('GET', '/api/conversations');
    const conv = await detail(c, list.body.conversations[0]!.id);
    assert.equal(conv.messages[1]!.status, 'cancelled');
    assert.equal(conv.messages[0]!.files[0]!.name, 'a.md');

    const invalid = await c.json('POST', '/api/import/local', { conversations: [{ title: '', model: 'x', createdAt: 0, updatedAt: 0, messages: [] }] });
    assert.equal(invalid.status, 422);
  });

  test('manutenção fecha gerações órfãs e apaga ficheiros soltos antigos', async () => {
    const c = await newUser();
    const id = await newConversation(c);
    const r = await send(c, id, 'olá');
    await app.db.query("UPDATE messages SET status = 'streaming', updated_at = now() - interval '10 minutes' WHERE id = $1", [r.assistantId]);
    const loose = await c.json<{ file: { id: string } }>('POST', '/api/files', Buffer.from('solto'));
    await app.db.query("UPDATE files SET created_at = now() - interval '2 days' WHERE id = $1", [loose.body.file.id]);
    await runMaintenance(app.db, app.storage, () => {});
    assert.equal((await detail(c, id)).messages[1]!.status, 'cancelled');
    assert.equal((await c.request('GET', `/api/files/${loose.body.file.id}/content`)).status, 404);
  });
});

test('auditoria regista eventos sem dados sensíveis', async () => {
  const r = await app.db.query<{ action: string; metadata: unknown }>('SELECT action, metadata FROM audit_log');
  const actions = new Set(r.rows.map((x) => x.action));
  for (const a of ['auth.signup', 'auth.login', 'auth.login_failed', 'auth.logout', 'conversation.delete', 'file.upload', 'import.local']) {
    assert.ok(actions.has(a), `falta ${a}`);
  }
  assert.doesNotMatch(JSON.stringify(r.rows), /palavra-passe|privado|confidencial/);
});
