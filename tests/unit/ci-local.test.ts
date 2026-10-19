import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTap } from '../../scripts/ci-local.ts';

const TAP = `TAP version 13
ok 1 - a
ok 2 - b # SKIP sem AppArmor neste anfitrião
    not ok 1 - interno
not ok 3 - falha real
# tests 3
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 1
# todo 0
# duration_ms 12.5
`;

test('parseTap lê contagens, ignorados com motivo e falhas', () => {
  const r = parseTap(TAP);
  assert.deepEqual(r.counts, { tests: 3, pass: 1, fail: 1, skipped: 1, cancelled: 0, todo: 0 });
  assert.deepEqual(r.skips, [{ name: 'b', reason: 'sem AppArmor neste anfitrião' }]);
  assert.deepEqual(r.failures, ['interno', 'falha real']);
});

test('parseTap sem resumo devolve counts indefinido (a CI local trata como falha, nunca como aprovado)', () => {
  assert.equal(parseTap('lixo qualquer').counts, undefined);
});

test('um ignorado sem motivo declarado fica marcado como tal', () => {
  assert.equal(parseTap('ok 1 - x # SKIP\n').skips[0]?.reason, '(sem motivo declarado)');
});
