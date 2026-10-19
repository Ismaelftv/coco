import { test } from 'node:test';
import assert from 'node:assert/strict';
import { somar, subtrair, multiplicar, dividir } from '../src/calc.js';

test('somar', () => assert.equal(somar(2, 3), 5));
test('subtrair', () => {
  assert.equal(subtrair(10, 4), 6);
  assert.equal(subtrair(0, 5), -5);
});
test('multiplicar', () => assert.equal(multiplicar(3, 4), 12));
test('dividir', () => {
  assert.equal(dividir(9, 3), 3);
  assert.throws(() => dividir(1, 0), RangeError);
});
