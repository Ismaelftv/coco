import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dobro } from '../../src/dobro.js';

test('negativos', () => assert.equal(dobro(-4), -8));
test('decimais', () => assert.equal(dobro(1.5), 3));
