import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutcome } from '../../server/agent/classify.ts';

type R = Parameters<typeof classifyOutcome>[0];
const step = (tool: string, ok: boolean, errorCode?: string) => ({ iteration: 1, kind: 'tool', tool, ok, ...(errorCode ? { errorCode } : {}) });
const report = (steps: unknown[]): R => ({ status: 'failed', stopReason: 'max_iterations', steps, changedFiles: [], criteria: [] }) as unknown as R;

test('só recusas legítimas (conflict/invalid/repeated) sem alterações → edit_refused', () => {
  const o = classifyOutcome(report([step('edit_file', false, 'conflict'), step('edit_file', false, 'repeated')]));
  assert.equal(o.outcome, 'edit_refused');
  assert.match(o.detail, /recusadas pela ferramenta/);
});

test('falha real da ferramenta (failed) → tool_failure, mesmo misturada com recusas', () => {
  assert.equal(classifyOutcome(report([step('edit_file', false, 'conflict'), step('edit_file', false, 'failed')])).outcome, 'tool_failure');
  assert.equal(classifyOutcome(report([step('write_file', false, 'failed')])).outcome, 'tool_failure');
});

test('código de erro desconhecido é tratado como falha da ferramenta (conservador)', () => {
  assert.equal(classifyOutcome(report([step('edit_file', false, 'qualquer')])).outcome, 'tool_failure');
  assert.equal(classifyOutcome(report([step('edit_file', false)])).outcome, 'tool_failure');
});

test('sem tentativas de escrita → model_no_action', () => {
  assert.equal(classifyOutcome(report([step('read_file', true)])).outcome, 'model_no_action');
});
