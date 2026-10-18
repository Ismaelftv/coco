import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeHref } from '../../apps/web/src/lib/url.ts';
import { validateAttachment } from '../../apps/web/src/lib/attachments.ts';
import { dateGroup, groupByDate } from '../../apps/web/src/lib/time.ts';
import { LEGACY_KEY, clearLegacy, readLegacy, type KeyValueStorage } from '../../apps/web/src/features/chat/legacy.ts';

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
  assert.equal(validateAttachment({ name: 'foto.png', size: 10, type: 'image/png' }, 0), null);
  assert.equal(validateAttachment({ name: 'doc.pdf', size: 5_000_000, type: 'application/pdf' }, 0), null);
  assert.equal(validateAttachment({ name: 'foto.png', size: 11_000_000, type: 'image/png' }, 0), 'too-large');
  assert.equal(validateAttachment({ name: 'app.exe', size: 10, type: 'application/x-msdownload' }, 0), 'unsupported-type');
  assert.equal(validateAttachment({ name: 'a.ts', size: 2_000_000, type: '' }, 0), 'too-large');
  assert.equal(validateAttachment({ name: 'a.ts', size: 0, type: '' }, 0), 'empty');
  assert.equal(validateAttachment({ name: 'a.ts', size: 10, type: '' }, 5), 'too-many');
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
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

test('histórico da Fase 2: lê, normaliza, ignora lixo e apaga', () => {
  const storage = memoryStorage();
  storage.setItem(LEGACY_KEY, JSON.stringify([
    { id: 'x', title: ' Antiga ', model: 'forja-sim', createdAt: 1, updatedAt: 2, messages: [
      { id: 'm', role: 'user', content: 'olá', createdAt: 1, status: 'complete', attachments: [{ name: 'a.md', mediaType: 'text/markdown', size: 3, content: '# a' }] },
      { id: 'n', role: 'hacker', content: 'x', createdAt: 1, status: 'complete' },
    ] },
    { id: 1 },
  ]));
  const legacy = readLegacy(storage);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0]!.title, 'Antiga');
  assert.equal(legacy[0]!.messages.length, 1);
  assert.deepEqual(legacy[0]!.messages[0]!.attachments, [{ name: 'a.md', mediaType: 'text/markdown', content: '# a' }]);
  clearLegacy(storage);
  assert.deepEqual(readLegacy(storage), []);
  storage.setItem(LEGACY_KEY, '{nao json');
  assert.deepEqual(readLegacy(storage), []);
  assert.deepEqual(readLegacy(null), []);
});
