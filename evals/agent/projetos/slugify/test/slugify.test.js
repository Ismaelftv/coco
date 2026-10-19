import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';

test('minúsculas e hífenes', () => assert.equal(slugify('Olá Mundo'), 'ola-mundo'));
test('remove acentos', () => assert.equal(slugify('Ação e Coração'), 'acao-e-coracao'));
test('remove pontuação e espaços repetidos', () => assert.equal(slugify('  Isto,   é  um teste!  '), 'isto-e-um-teste'));
test('números mantêm-se', () => assert.equal(slugify('Fase 5 da Forja'), 'fase-5-da-forja'));
test('texto vazio', () => assert.equal(slugify('   '), ''));
