import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saudar } from '../../src/saudacao.js';

test('nomes compostos', () => assert.equal(saudar('Ana Maria'), 'Olá, Ana Maria!'));
test('nome vazio não rebenta', () => assert.equal(typeof saudar(''), 'string'));
