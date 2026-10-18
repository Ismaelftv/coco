import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../../apps/web/src/lib/sse.ts';
import { formatSse } from '../../server/sse.ts';

test('analisa eventos completos', () => {
  const p = createSseParser();
  const out = p.feed('event: delta\ndata: {"text":"olá"}\n\nevent: message.end\ndata: {}\n\n');
  assert.deepEqual(out, [
    { event: 'delta', data: '{"text":"olá"}' },
    { event: 'message.end', data: '{}' },
  ]);
});

test('junta fragmentos cortados a meio de uma linha', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('event: del'), []);
  assert.deepEqual(p.feed('ta\ndata: {"te'), []);
  assert.deepEqual(p.feed('xt":"a"}\n'), []);
  assert.deepEqual(p.feed('\n'), [{ event: 'delta', data: '{"text":"a"}' }]);
});

test('aceita CRLF, incluindo \\r\\n dividido entre fragmentos', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('data: a\r'), []);
  assert.deepEqual(p.feed('\n\r\n'), [{ event: 'message', data: 'a' }]);
});

test('une várias linhas data com \\n e ignora comentários', () => {
  const p = createSseParser();
  const out = p.feed(': ping\ndata: linha 1\ndata: linha 2\n\n');
  assert.deepEqual(out, [{ event: 'message', data: 'linha 1\nlinha 2' }]);
});

test('flush despacha evento pendente sem linha vazia final', () => {
  const p = createSseParser();
  p.feed('event: error\ndata: {"code":"x"}');
  assert.deepEqual(p.flush(), [{ event: 'error', data: '{"code":"x"}' }]);
});

test('ida e volta com o formatador do servidor', () => {
  const p = createSseParser();
  const wire = formatSse({ type: 'delta', data: { text: 'linha\ncom "aspas"' } });
  const [ev] = p.feed(wire);
  assert.equal(ev?.event, 'delta');
  assert.deepEqual(JSON.parse(ev!.data), { text: 'linha\ncom "aspas"' });
});
