import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatReducer,
  deriveTitle,
  initialChatState,
  searchConversations,
  sortedConversations,
  type ChatState,
} from '../../apps/web/src/features/chat/store.ts';
import { toRequestMessages } from '../../apps/web/src/features/chat/useChat.ts';

const NOW = 1_700_000_000_000;

function withConversation(): ChatState {
  return chatReducer(initialChatState, { type: 'create', id: 'c1', model: 'forja-sim', now: NOW });
}

function sent(): ChatState {
  return chatReducer(withConversation(), {
    type: 'sendUser',
    conversationId: 'c1',
    message: { id: 'u1', content: 'Olá mundo\nsegunda linha' },
    assistantId: 'a1',
    model: 'forja-sim',
    now: NOW + 1,
  });
}

test('criar conversa ativa-a', () => {
  const s = withConversation();
  assert.equal(s.activeId, 'c1');
  assert.equal(s.conversations.c1?.title, 'Nova conversa');
});

test('enviar mensagem: título derivado, assistente em streaming, geração registada', () => {
  const s = sent();
  const c = s.conversations.c1!;
  assert.equal(c.title, 'Olá mundo');
  assert.deepEqual(c.messages.map((m) => [m.role, m.status]), [
    ['user', 'complete'],
    ['assistant', 'streaming'],
  ]);
  assert.deepEqual(s.generation, { conversationId: 'c1', messageId: 'a1' });
});

test('não aceita um segundo envio durante uma geração', () => {
  const s = sent();
  const again = chatReducer(s, {
    type: 'sendUser',
    conversationId: 'c1',
    message: { id: 'u2', content: 'x' },
    assistantId: 'a2',
    model: 'forja-sim',
    now: NOW + 2,
  });
  assert.equal(again, s);
});

test('deltas acumulam e finish conclui e liberta a geração', () => {
  let s = sent();
  s = chatReducer(s, { type: 'appendDelta', conversationId: 'c1', messageId: 'a1', text: 'Olá' });
  s = chatReducer(s, { type: 'appendDelta', conversationId: 'c1', messageId: 'a1', text: ', tudo bem?' });
  s = chatReducer(s, { type: 'finish', conversationId: 'c1', messageId: 'a1', finishReason: 'stop', now: NOW + 3 });
  const a = s.conversations.c1!.messages[1]!;
  assert.equal(a.content, 'Olá, tudo bem?');
  assert.equal(a.status, 'complete');
  assert.equal(s.generation, null);
});

test('cancelamento mantém o texto parcial', () => {
  let s = sent();
  s = chatReducer(s, { type: 'appendDelta', conversationId: 'c1', messageId: 'a1', text: 'parcial' });
  s = chatReducer(s, { type: 'finish', conversationId: 'c1', messageId: 'a1', finishReason: 'cancelled', now: NOW + 3 });
  const a = s.conversations.c1!.messages[1]!;
  assert.equal(a.status, 'cancelled');
  assert.equal(a.content, 'parcial');
});

test('deltas depois do fim são ignorados', () => {
  let s = sent();
  s = chatReducer(s, { type: 'finish', conversationId: 'c1', messageId: 'a1', finishReason: 'stop', now: NOW + 3 });
  s = chatReducer(s, { type: 'appendDelta', conversationId: 'c1', messageId: 'a1', text: 'tarde' });
  assert.equal(s.conversations.c1!.messages[1]!.content, '');
});

test('erro marca a mensagem e truncateFrom repete a partir dela', () => {
  let s = sent();
  s = chatReducer(s, {
    type: 'fail',
    conversationId: 'c1',
    messageId: 'a1',
    error: { code: 'x', message: 'falhou', retryable: true },
    now: NOW + 3,
  });
  assert.equal(s.conversations.c1!.messages[1]!.status, 'error');
  assert.equal(s.generation, null);

  s = chatReducer(s, { type: 'truncateFrom', conversationId: 'c1', messageId: 'a1', assistantId: 'a2', model: 'forja-sim', now: NOW + 4 });
  const ids = s.conversations.c1!.messages.map((m) => m.id);
  assert.deepEqual(ids, ['u1', 'a2']);
  assert.deepEqual(s.generation, { conversationId: 'c1', messageId: 'a2' });
});

test('eliminar a conversa ativa limpa a seleção', () => {
  const s = chatReducer(withConversation(), { type: 'delete', id: 'c1' });
  assert.equal(s.activeId, null);
  assert.equal(s.conversations.c1, undefined);
});

test('renomear ignora títulos vazios', () => {
  const s = withConversation();
  assert.equal(chatReducer(s, { type: 'rename', id: 'c1', title: '   ' }), s);
  assert.equal(chatReducer(s, { type: 'rename', id: 'c1', title: ' Plano ' }).conversations.c1!.title, 'Plano');
});

test('deriveTitle encurta textos longos', () => {
  const t = deriveTitle('a'.repeat(200));
  assert.ok(t.length <= 60);
  assert.ok(t.endsWith('…'));
  assert.equal(deriveTitle('   '), 'Nova conversa');
});

test('pesquisa ignora acentos e maiúsculas e procura no conteúdo', () => {
  const s = sent();
  const list = sortedConversations(s);
  assert.equal(searchConversations(list, 'OLA').length, 1);
  assert.equal(searchConversations(list, 'segunda').length, 1);
  assert.equal(searchConversations(list, 'inexistente').length, 0);
});

test('toRequestMessages omite respostas falhadas e vazias', () => {
  const msgs = toRequestMessages([
    { id: '1', role: 'user', content: 'q1', createdAt: 0, status: 'complete' },
    { id: '2', role: 'assistant', content: 'x', createdAt: 0, status: 'error' },
    { id: '3', role: 'user', content: 'q2', createdAt: 0, status: 'complete' },
    { id: '4', role: 'assistant', content: '', createdAt: 0, status: 'cancelled' },
  ]);
  assert.deepEqual(msgs.map((m) => m.content), ['q1', 'q2']);
});
