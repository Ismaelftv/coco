import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuid } from '../../apps/web/src/lib/uuid.ts';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('uuid: funciona sem crypto.randomUUID (página http, contexto inseguro)', () => {
  const real = globalThis.crypto;
  const fake = { getRandomValues: (a: Uint8Array<ArrayBuffer>) => real.getRandomValues(a) } as unknown as Crypto;
  Object.defineProperty(globalThis, 'crypto', { value: fake, configurable: true });
  try {
    const ids = new Set(Array.from({ length: 200 }, () => uuid()));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, V4);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
  assert.match(uuid(), V4);
});
