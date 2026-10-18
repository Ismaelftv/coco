import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saudar } from '../src/saudacao.js';

test('saudação completa', () => assert.equal(saudar('Ana'), 'Olá, Ana!'));
