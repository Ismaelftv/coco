import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatReducer, deriveTitle, initialChatState, sortedConversations, type ChatState } from '../../apps/web/src/features/chat/store.ts';
import { fromDetail, fromSummary } from '../../apps/web/src/features/chat/types.ts';
import type { FileInfo } from '../../shared/contract.ts';

const NOW = 1_700_000_000_000;
const FILE: FileInfo = { id: 'f1', name: 'notas.md', mediaType: 'text/plain', kind: 'text', size: 10, createdAt: '2026-10-18T00:00:00Z' };

function withConversation(): ChatState {
  return chatReducer(initialChatState, { type: 'create', id: 'c1', model: 'forja-sim', now: NOW });
}

function sent(content = 'Olá mundo\nsegunda linha', files: FileInfo[] = []): ChatState {
  return chatReducer(withConversation(), {
    type: 'sendUser',
    conversationId: 'c1',
    message: { id: 'u1', content, files },
    assistantId: 'a1',
    model: 'forja-sim',
    now: NOW + 1,
  });
}

test('criar conversa ativa-a e marca-a como carregada', () => {
  const s = withConversation();
  assert.equal(s.activeId, 'c1');
  assert.equal(s.conversations.c1?.loaded, true);
});

test('enviar mensagem: título derivado, assistente em streaming, geração registada', () => {
  const s = sent();
  const c = s.conversations.c1!;
  assert.equal(c.title, 'Olá mundo');
  assert.deepEqual(c.messages.map((m) => [m.role, m.status]), [['user', 'complete'], ['assistant', 'streaming']]);
  assert.deepEqual(s.generation, { conversationId: 'c1', messageId: 'a1' });
});

test('título a partir do anexo quando não há texto', () => {
  assert.equal(sent('', [FILE]).conversations.c1!.title, 'notas.md');
});

test('não aceita um segundo envio durante uma geração', () => {
  const s = sent();
  const again = chatReducer(s, {
    type: 'sendUser', conversationId: 'c1', message: { id: 'u2', content: 'x', files: [] }, assistantId: 'a2', model: 'forja-sim', now: NOW + 2,
  });
  assert.equal(again, s);
});

test('deltas acumulam; finish conclui; deltas tardios são ignorados', () => {
  let s = sent();
  s = chatReducer(s, { type: 'appendDelta', conversationId: 'c1', messageId: 'a1', text: 'Olá' });
  s = chatReducer(s, { type: 'appendDelta', conversationId: 'c1', messageId: 'a1', text: ', tudo bem?' });
  s = chatReducer(s, { type: 'finish', conversationId: 'c1', messageId: 'a1', finishReason: 'stop', now: NOW + 3 });
  s = chatReducer(s, { type: 'appendDelta', conversationId: 'c1', messageId: 'a1', text: 'tarde' });
  const a = s.conversations.c1!.messages[1]!;
  assert.equal(a.content, 'Olá, tudo bem?');
  assert.equal(a.status, 'complete');
  assert.equal(s.generation, null);
});

test('cancelamento mantém o texto parcial', () => {
  let s = sent();
  s = chatReducer(s, { type: 'appendDelta', conversationId: 'c1', messageId: 'a1', text: 'parcial' });
  s = chatReducer(s, { type: 'finish', conversationId: 'c1', messageId: 'a1', finishReason: 'cancelled', now: NOW + 3 });
  assert.equal(s.conversations.c1!.messages[1]!.status, 'cancelled');
  assert.equal(s.conversations.c1!.messages[1]!.content, 'parcial');
});

test('erro antes de o servidor gravar fica marcado para reenvio', () => {
  let s = sent();
  s = chatReducer(s, { type: 'fail', conversationId: 'c1', messageId: 'a1', error: { code: 'network', message: 'x', retryable: true }, now: NOW + 3, notPersisted: true });
  const a = s.conversations.c1!.messages[1]!;
  assert.equal(a.status, 'error');
  assert.equal(a.notPersisted, true);
  s = chatReducer(s, { type: 'truncateFrom', conversationId: 'c1', messageId: 'a1', assistantId: 'a2', model: 'forja-sim', now: NOW + 4 });
  assert.deepEqual(s.conversations.c1!.messages.map((m) => m.id), ['u1', 'a2']);
  assert.deepEqual(s.generation, { conversationId: 'c1', messageId: 'a2' });
});

test('hydrate substitui a lista mas preserva a conversa ativa e as já carregadas', () => {
  let s = sent();
  s = chatReducer(s, { type: 'finish', conversationId: 'c1', messageId: 'a1', finishReason: 'stop', now: NOW + 3 });
  const summary = { id: 'c2', title: 'Outra', model: 'forja-sim', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' };
  s = chatReducer(s, { type: 'hydrate', conversations: [fromSummary(summary), fromSummary({ ...summary, id: 'c1', title: 'Renomeada' })] });
  assert.equal(s.conversations.c2?.loaded, false);
  assert.equal(s.conversations.c1?.messages.length, 2, 'mensagens carregadas mantêm-se');
  assert.equal(s.conversations.c1?.title, 'Renomeada');
  s = chatReducer(s, { type: 'hydrate', conversations: [{ ...fromSummary(summary), id: 'c3' }], append: true });
  assert.ok(s.conversations.c2 && s.conversations.c3);
});

test('loaded não substitui a conversa com geração em curso', () => {
  const s = sent();
  const detail = fromDetail({ id: 'c1', title: 't', model: 'forja-sim', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', messages: [] });
  assert.equal(chatReducer(s, { type: 'loaded', conversation: detail }), s);
});

test('eliminar e restaurar (rollback de falha no servidor)', () => {
  const s = withConversation();
  const before = s.conversations.c1!;
  const deleted = chatReducer(s, { type: 'delete', id: 'c1' });
  assert.equal(deleted.activeId, null);
  assert.equal(deleted.conversations.c1, undefined);
  assert.equal(chatReducer(deleted, { type: 'restore', conversation: before }).conversations.c1, before);
});

test('renomear ignora títulos vazios', () => {
  const s = withConversation();
  assert.equal(chatReducer(s, { type: 'rename', id: 'c1', title: '   ' }), s);
  assert.equal(chatReducer(s, { type: 'rename', id: 'c1', title: ' Plano ' }).conversations.c1!.title, 'Plano');
});

test('deriveTitle encurta textos longos', () => {
  const t = deriveTitle('a'.repeat(200));
  assert.ok(t.length <= 60 && t.endsWith('…'));
  assert.equal(deriveTitle('   '), 'Nova conversa');
});

test('ordenação por atividade recente', () => {
  let s = withConversation();
  s = chatReducer(s, { type: 'create', id: 'c2', model: 'forja-sim', now: NOW + 10 });
  assert.deepEqual(sortedConversations(s).map((c) => c.id), ['c2', 'c1']);
});
