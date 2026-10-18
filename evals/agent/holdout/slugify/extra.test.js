import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../../src/slugify.js';

test('hífenes repetidos colapsam', () => assert.equal(slugify('A -- B'), 'a-b'));
test('sem hífenes nas pontas', () => assert.equal(slugify('---x---'), 'x'));
test('ñ e outros diacríticos', () => assert.equal(slugify('Mañana Çá'), 'manana-ca'));
test('símbolos', () => assert.equal(slugify('C++ & Java'), 'c-java'));
test('só símbolos → vazio', () => assert.equal(slugify('!!! ???'), ''));
test('é determinístico', () => assert.equal(slugify(slugify('Olá Mundo')), 'ola-mundo'));
