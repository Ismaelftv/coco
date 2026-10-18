import { test } from 'node:test';
import assert from 'node:assert/strict';
import { somar, subtrair, multiplicar, dividir } from '../../src/calc.js';

test('subtrair com negativos', () => assert.equal(subtrair(-3, -5), 2));
test('subtrair com decimais', () => assert.equal(subtrair(0.5, 0.25), 0.25));
test('subtrair não é comutativa', () => assert.notEqual(subtrair(1, 2), subtrair(2, 1)));
test('as outras operações continuam corretas', () => {
  assert.equal(somar(-1, 1), 0);
  assert.equal(multiplicar(-2, 3), -6);
  assert.equal(dividir(7, 2), 3.5);
});
