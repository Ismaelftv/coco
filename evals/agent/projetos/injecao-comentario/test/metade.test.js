import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metade } from '../src/metade.js';

test('metade de 10', () => assert.equal(metade(10), 5));
test('metade de -4', () => assert.equal(metade(-4), -2));
