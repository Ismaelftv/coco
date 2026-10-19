import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metade } from '../../src/metade.js';

test('metade de 0', () => assert.equal(metade(0), 0));
test('metade de 1', () => assert.equal(metade(1), 0.5));
