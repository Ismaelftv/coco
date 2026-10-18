import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeHref } from '../../apps/web/src/lib/url.ts';
import { looksBinary, validateAttachment } from '../../apps/web/src/lib/attachments.ts';
import { dateGroup, groupByDate } from '../../apps/web/src/lib/time.ts';
import { createLocalRepository, type KeyValueStorage } from '../../apps/web/src/features/chat/repository.ts';
import type { Conversation } from '../../apps/web/src/features/chat/types.ts';

test('safeHref aceita http(s) e mailto e bloqueia esquemas perigosos', () => {
  assert.equal(safeHref('https://exemplo.pt/a?b=1'), 'https://exemplo.pt/a?b=1');
  assert.equal(safeHref('mailto:ola@exemplo.pt'), 'mailto:ola@exemplo.pt');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('JaVaScRiPt:alert(1)'), null);
  assert.equal(safeHref('java\tscript:alert(1)'), null);
  assert.equal(safeHref(' \u0001javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,<script>'), null);
  assert.equal(safeHref('/relativo'), null);
  assert.equal(safeHref(''), null);
});

test('validação de anexos', () => {
  assert.equal(validateAttachment({ name: 'a.ts', size: 10, type: '' }, 0), null);
  assert.equal(validateAttachment({ name: 'notas', size: 10, type: 'text/plain' }, 0), null);
  assert.equal(validateAttachment({ name: 'foto.png', size: 10, type: 'image/png' }, 0), 'unsupported-type');
  assert.equal(validateAttachment({ name: 'a.ts', size: 10_000_000, type: '' }, 0), 'too-large');
  assert.equal(validateAttachment({ name: 'a.ts', size: 0, type: '' }, 0), 'empty');
  assert.equal(validateAttachment({ name: 'a.ts', size: 10, type: '' }, 5), 'too-many');
  assert.equal(looksBinary('abc\u0000def'), true);
  assert.equal(looksBinary('texto normal'), false);
});

test('agrupamento por data', () => {
  const now = new Date(2026, 9, 18, 15, 0).getTime();
  assert.equal(dateGroup(new Date(2026, 9, 18, 1).getTime(), now), 'Hoje');
  assert.equal(dateGroup(new Date(2026, 9, 17, 23).getTime(), now), 'Ontem');
  assert.equal(dateGroup(new Date(2026, 9, 13).getTime(), now), 'Últimos 7 dias');
  assert.equal(dateGroup(new Date(2026, 8, 25).getTime(), now), 'Últimos 30 dias');
  assert.equal(dateGroup(new Date(2025, 0, 1).getTime(), now), 'Mais antigas');
  const groups = groupByDate([{ t: now }, { t: new Date(2025, 0, 1).getTime() }, { t: now - 1 }], (x) => x.t, now);
  assert.deepEqual(groups.map((g) => [g.group, g.items.length]), [['Hoje', 2], ['Mais antigas', 1]]);
});

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const conv = (id: string, updatedAt: number, status: 'complete' | 'streaming' = 'complete'): Conversation => ({
  id,
  title: id,
  createdAt: 0,
  updatedAt,
  model: 'forja-sim',
  messages: [{ id: `${id}-m`, role: 'assistant', content: 'x', createdAt: 0, status }],
});

test('repositório local: ida e volta e recuperação de gerações interrompidas', () => {
  const storage = memoryStorage();
  const repo = createLocalRepository(storage);
  repo.save([conv('a', 1), conv('b', 2, 'streaming')]);
  const loaded = repo.load();
  assert.deepEqual(loaded.map((c) => c.id), ['b', 'a']);
  assert.equal(loaded[0]!.messages[0]!.status, 'cancelled');
});

test('repositório local: ignora dados corrompidos', () => {
  const storage = memoryStorage();
  storage.setItem('forja.conversations.v1', '{nao json');
  assert.deepEqual(createLocalRepository(storage).load(), []);
  storage.setItem('forja.conversations.v1', JSON.stringify([{ id: 1 }, conv('ok', 1)]));
  assert.deepEqual(createLocalRepository(storage).load().map((c) => c.id), ['ok']);
  assert.deepEqual(createLocalRepository(null).load(), []);
});
