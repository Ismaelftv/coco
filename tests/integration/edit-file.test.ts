/**
 * edit_file / write_file: ocorrências ambíguas, versões obsoletas, caminhos, falhas de escrita e atomicidade.
 * Todos os testes verificam o estado REAL dos ficheiros no disco (bytes), não só a mensagem devolvida.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeIO, findOccurrences, planEdit, versionOf, type FileIO } from '../../server/agent/edit.ts';
import { ProcessSandbox } from '../../server/agent/sandbox.ts';
import { DEFAULT_TOOL_LIMITS, ToolRegistry, type ToolContext } from '../../server/agent/tools.ts';
import { Workspace } from '../../server/agent/workspace.ts';

const CALC = `export function somar(a, b) {
  return a + b;
}

export function subtrair(a, b) {
  return a + b;
}

export function multiplicar(a, b) {
  return a * b;
}
`;
const registry = new ToolRegistry();
const dirs: string[] = [];
const spaces: Workspace[] = [];
after(async () => {
  for (const w of spaces) await w.dispose();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function setup(files: Record<string, string | Buffer> = { 'src/calc.js': CALC }, io?: FileIO) {
  const src = await mkdtemp(join(tmpdir(), 'forja-edit-'));
  dirs.push(src);
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(src, p, '..'), { recursive: true });
    await writeFile(join(src, p), c);
  }
  const ws = await Workspace.create(src);
  spaces.push(ws);
  const ctx: ToolContext = { ws, sandbox: new ProcessSandbox(), commands: [], limits: DEFAULT_TOOL_LIMITS, confirm: async () => false, signal: new AbortController().signal, io };
  const edit = (args: Record<string, unknown>) => registry.execute('edit_file', { path: 'src/calc.js', ...args }, ctx);
  const disk = (p = 'src/calc.js') => readFile(join(ws.root, p), 'utf8');
  const leftovers = async (d = 'src') => (await readdir(join(ws.root, d))).filter((f) => f.endsWith('.tmp'));
  return { ws, ctx, edit, disk, leftovers };
}
const FIX = { oldText: '  return a + b;', newText: '  return a - b;' };

describe('zero, uma e várias ocorrências', () => {
  test('zero: recusa, nada muda e indica onde a primeira linha existe', async () => {
    const { edit, disk } = await setup();
    const out = await edit({ oldText: '    return a + b;\n}', newText: 'x' });
    assert.equal(out.ok, false);
    assert.equal(out.errorCode, 'conflict');
    assert.match(out.content, /não existe/);
    assert.match(out.content, /Nada foi alterado/);
    assert.match(out.content, /existe em: 2, 6/, 'sugere as linhas com a primeira linha do excerto');
    assert.equal(await disk(), CALC);
  });

  test('uma: aplica, reabre e valida; sem ficheiros temporários; permissões preservadas', async () => {
    const { edit, disk, leftovers, ws } = await setup({ 'src/calc.js': CALC.replace('  return a + b;\n}\n\nexport function subtrair', '  return a + b;\n}\n\nexport function subtrair') });
    await chmod(join(ws.root, 'src/calc.js'), 0o750);
    const out = await edit({ oldText: 'return a * b;', newText: 'return b * a;' });
    assert.equal(out.ok, true, out.content);
    assert.match(out.content, /linha 10/);
    assert.match(out.content, /verificada ao reabrir/);
    assert.match(await disk(), /return b \* a;/);
    assert.deepEqual(await leftovers(), []);
    assert.equal((await stat(join(ws.root, 'src/calc.js'))).mode & 0o777, 0o750);
    assert.deepEqual(out.changedFiles, ['src/calc.js']);
  });

  test('várias: recusa SEM escolher; devolve linhas, contexto, versão e instruções; ficheiro intacto', async () => {
    const { edit, disk } = await setup();
    const out = await edit(FIX);
    assert.equal(out.ok, false);
    assert.equal(out.errorCode, 'conflict');
    assert.match(out.content, /aparece 2 vezes/);
    assert.match(out.content, /Ocorrência 1 \(linha 2\)/);
    assert.match(out.content, /Ocorrência 2 \(linha 6\)/);
    assert.match(out.content, />\s+6\|   return a \+ b;/, 'a linha da ocorrência está marcada');
    assert.match(out.content, /\s+5\| export function subtrair/, 'contexto à volta');
    assert.match(out.content, new RegExp(`version: "${versionOf(CALC)}"`));
    assert.match(out.content, /expectedMatches: 2/);
    assert.equal(await disk(), CALC, 'nenhuma substituição, nem global nem da primeira');
    assert.equal((await disk()).split('return a + b;').length - 1, 2, 'continuam as duas');
  });

  test('várias: `line` escolhe exatamente a ocorrência indicada', async () => {
    const { edit, disk } = await setup();
    const out = await edit({ ...FIX, line: 6, version: versionOf(CALC) });
    assert.equal(out.ok, true, out.content);
    const lines = (await disk()).split('\n');
    assert.equal(lines[1], '  return a + b;', 'a outra ocorrência (somar) ficou');
    assert.equal(lines[5], '  return a - b;');
  });

  test('várias: `occurrence` + `expectedMatches` escolhe; sem expectedMatches ou fora do intervalo é recusado', async () => {
    const a = await setup();
    assert.equal((await a.edit({ ...FIX, occurrence: 1, expectedMatches: 3 })).ok, false, 'expectedMatches errado');
    assert.equal(await a.disk(), CALC);
    const b = await setup();
    const two = await b.edit({ oldText: 'return a + b;', newText: 'return a - b;', occurrence: 2, expectedMatches: 2 });
    assert.equal(two.ok, true, two.content);
    assert.equal((await b.disk()).split('\n')[5], '  return a - b;');
    const c = await setup();
    const semExp = await c.edit({ oldText: 'return a + b;', newText: 'x', occurrence: 1 });
    assert.equal(semExp.errorCode, 'invalid');
    const fora = await c.edit({ oldText: 'return a + b;', newText: 'x', occurrence: 3, expectedMatches: 2 });
    assert.equal(fora.errorCode, 'invalid');
    assert.equal(await c.disk(), CALC);
  });

  test('`line` sem ocorrência nessa linha, `line` e `occurrence` juntos: recusados', async () => {
    const { edit, disk } = await setup();
    const sem = await edit({ ...FIX, line: 3 });
    assert.equal(sem.ok, false);
    assert.match(sem.content, /Nenhuma ocorrência .* começa na linha 3/);
    assert.match(sem.content, /Começam em: 2, 6/);
    const ambos = await edit({ ...FIX, line: 2, occurrence: 1, expectedMatches: 2 });
    assert.equal(ambos.errorCode, 'invalid');
    assert.equal(await disk(), CALC);
  });

  test('ocorrências sobrepostas contam-se todas ("aa" em "aaa" são 2) e continuam ambíguas', async () => {
    assert.equal(findOccurrences('aaa', 'aa').length, 2);
    const { edit, disk } = await setup({ 'src/calc.js': 'aaa\n' });
    const out = await edit({ oldText: 'aa', newText: 'b' });
    assert.equal(out.ok, false);
    assert.equal(await disk(), 'aaa\n');
  });

  test('duas ocorrências na mesma linha: `line` não desambigua (pede mais contexto)', async () => {
    const { edit, disk } = await setup({ 'src/calc.js': 'x = a + b; y = a + b;\n' });
    const out = await edit({ oldText: 'a + b', newText: 'a - b', line: 1 });
    assert.equal(out.ok, false);
    assert.match(out.content, /Mais de uma ocorrência começa na linha 1/);
    assert.equal(await disk(), 'x = a + b; y = a + b;\n');
  });

  test('newText igual a oldText: sem alteração', async () => {
    const { edit } = await setup();
    assert.equal((await edit({ oldText: 'return a * b;', newText: 'return a * b;' })).errorCode, 'invalid');
  });

  test('texto copiado com números de linha e fins de linha CRLF continuam a funcionar sem misturar terminadores', async () => {
    const crlf = CALC.replace(/\n/g, '\r\n');
    const { edit, disk } = await setup({ 'src/calc.js': crlf });
    const out = await edit({ oldText: '   9| export function multiplicar(a, b) {\n  10|   return a * b;', newText: 'export function multiplicar(a, b) {\n  return b * a;' });
    assert.equal(out.ok, true, out.content);
    const after = await disk();
    assert.match(after, /multiplicar\(a, b\) \{\r\n  return b \* a;\r\n\}/);
    assert.equal(after.replace(/\r\n/g, '').includes('\n'), false, 'sem LF soltos');
  });
});

describe('conteúdo obsoleto', () => {
  test('versão desatualizada: recusa e diz que o ficheiro mudou', async () => {
    const { edit, disk, ws } = await setup();
    const antiga = versionOf(CALC);
    await writeFile(join(ws.root, 'src/calc.js'), CALC + '// novo\n');
    const out = await edit({ ...FIX, line: 6, version: antiga });
    assert.equal(out.ok, false);
    assert.match(out.content, /mudou desde que o leste/);
    assert.equal(await disk(), CALC + '// novo\n');
  });

  test('número de ocorrências mudou desde a listagem: recusa com a nova lista', async () => {
    const { edit, disk, ws } = await setup();
    const alterado = CALC.replace('return a * b;', 'return a + b;');
    await writeFile(join(ws.root, 'src/calc.js'), alterado);
    const out = await edit({ ...FIX, occurrence: 2, expectedMatches: 2 });
    assert.equal(out.ok, false);
    assert.match(out.content, /tem agora 3/);
    assert.equal(await disk(), alterado);
  });

  test('o ficheiro muda entre o planeamento e a escrita: a escrita é recusada e a alteração alheia fica', async () => {
    let tocou = false;
    const io: FileIO = {
      ...nodeIO,
      async read(abs) {
        if (!tocou && !abs.endsWith('.tmp')) {
          tocou = true;
          await writeFile(abs, 'ALTERADO POR OUTRO\n');
        }
        return nodeIO.read(abs);
      },
    };
    const { edit, disk, leftovers } = await setup({ 'src/calc.js': CALC }, io);
    const out = await edit({ oldText: 'return a * b;', newText: 'return b * a;' });
    assert.equal(out.ok, false);
    assert.match(out.content, /mudou desde que foi lido/);
    assert.equal(await disk(), 'ALTERADO POR OUTRO\n');
    assert.deepEqual(await leftovers(), []);
  });
});

describe('caminhos e permissões', () => {
  test('inválidos: fora da raiz, absolutos, .git, segredo, diretório, inexistente, binário, não-UTF-8, link simbólico', async () => {
    const { edit, ws } = await setup({ 'src/calc.js': CALC, '.env': 'TOKEN=abc\n', 'bin.dat': Buffer.from([0, 1, 2, 3, 0, 0]), 'latin.txt': Buffer.from([0x63, 0xe3, 0x6f, 0x0a]) });
    await symlink('/etc/hostname', join(ws.root, 'src/ligacao.js')).catch(() => {});
    const t = (path: string, extra: Record<string, unknown> = {}) => edit({ path, oldText: 'x', newText: 'y', ...extra });
    for (const p of ['../fora.js', '/etc/passwd', '.git/config', 'src/../../fora.js']) {
      const out = await t(p);
      assert.equal(out.ok, false, p);
      assert.match(out.errorCode ?? '', /path_denied|invalid|not_found/, p);
    }
    assert.equal((await t('src')).ok, false);
    assert.equal((await t('src/nao-existe.js')).errorCode, 'not_found');
    assert.equal((await t('bin.dat')).errorCode, 'invalid');
    const latin = await t('latin.txt', { oldText: 'c', newText: 'k' });
    assert.equal(latin.errorCode, 'invalid');
    assert.match(latin.content, /UTF-8/);
    assert.equal(await readFile(join(ws.root, 'latin.txt')).then((b) => [...b].join(',')), '99,227,111,10', 'bytes intactos');
    const link = await t('src/ligacao.js');
    assert.equal(link.ok, false);
  });

  test('ficheiros sensíveis exigem confirmação e, recusada, nada muda', async () => {
    const { ws, edit } = await setup({ 'src/calc.js': CALC, 'package.json': '{"scripts":{"test":"node --test"}}\n' });
    const before = await readFile(join(ws.root, 'package.json'), 'utf8');
    const out = await edit({ path: 'package.json', oldText: '"node --test"', newText: '"exit 0"' });
    assert.equal(out.ok, false);
    assert.equal(await readFile(join(ws.root, 'package.json'), 'utf8'), before);
  });

  test('limite de escrita respeitado (nada escrito)', async () => {
    const { edit, disk } = await setup();
    const out = await edit({ oldText: 'return a * b;', newText: 'x'.repeat(300 * 1024) });
    assert.equal(out.ok, false);
    assert.equal(await disk(), CALC);
  });
});

describe('falhas de escrita: nunca alterações parciais', () => {
  const partial: FileIO = {
    ...nodeIO,
    async writeNew(abs, data, mode) {
      await nodeIO.writeNew(abs, data.subarray(0, Math.floor(data.length / 2)), mode);
      throw Object.assign(new Error('disco cheio (simulado)'), { code: 'ENOSPC' });
    },
  };

  test('a escrita falha a meio: original intacto e temporário removido', async () => {
    const { edit, disk, leftovers } = await setup({ 'src/calc.js': CALC }, partial);
    const out = await edit({ oldText: 'return a * b;', newText: 'return b * a;' });
    assert.equal(out.ok, false);
    assert.equal(out.errorCode, 'failed');
    assert.match(out.content, /original não foi alterado/);
    assert.equal(await disk(), CALC);
    assert.deepEqual(await leftovers(), []);
  });

  test('o rename falha: original intacto e temporário removido', async () => {
    const io: FileIO = { ...nodeIO, rename: async () => { throw Object.assign(new Error('EXDEV simulado'), { code: 'EXDEV' }); } };
    const { edit, disk, leftovers } = await setup({ 'src/calc.js': CALC }, io);
    const out = await edit({ oldText: 'return a * b;', newText: 'return b * a;' });
    assert.equal(out.ok, false);
    assert.equal(await disk(), CALC);
    assert.deepEqual(await leftovers(), []);
  });

  test('a releitura não coincide com o esperado: o estado anterior é reposto', async () => {
    let renamed = false;
    const io: FileIO = {
      ...nodeIO,
      async rename(a, b) {
        await nodeIO.rename(a, b);
        renamed = true;
      },
      async read(abs) {
        const b = await nodeIO.read(abs);
        // Depois do rename, a primeira releitura devolve lixo (corrupção simulada); a reposição volta a ler normalmente.
        if (renamed && !abs.endsWith('.tmp')) {
          renamed = false;
          return Buffer.from('CORROMPIDO');
        }
        return b;
      },
    };
    const { edit, disk, leftovers } = await setup({ 'src/calc.js': CALC }, io);
    const out = await edit({ oldText: 'return a * b;', newText: 'return b * a;' });
    assert.equal(out.ok, false);
    assert.match(out.content, /verificação após escrever falhou.*reposto/);
    assert.equal(await disk(), CALC);
    assert.deepEqual(await leftovers(), []);
  });

  test('write_file com overwrite: falha a meio não deixa o ficheiro truncado; ficheiro novo falhado não fica criado', async () => {
    const { ctx, disk, leftovers, ws } = await setup({ 'src/calc.js': CALC }, partial);
    const a = await registry.execute('write_file', { path: 'src/calc.js', content: 'novo conteúdo\n', overwrite: true }, ctx);
    assert.equal(a.ok, false);
    assert.equal(await disk(), CALC);
    const b = await registry.execute('write_file', { path: 'src/novo.js', content: 'novo\n' }, ctx);
    assert.equal(b.ok, false);
    assert.equal(await stat(join(ws.root, 'src/novo.js')).then(() => true, () => false), false);
    assert.deepEqual(await leftovers(), []);
  });

  test('write_file e edit_file normais continuam a funcionar (compatibilidade)', async () => {
    const { ctx, disk } = await setup();
    const w = await registry.execute('write_file', { path: 'src/calc.js', content: 'ok\n', overwrite: true }, ctx);
    assert.equal(w.ok, true, w.content);
    assert.equal(await disk(), 'ok\n');
    const n = await registry.execute('write_file', { path: 'src/sub/novo.js', content: 'n\n' }, ctx);
    assert.equal(n.ok, true, n.content);
  });
});

test('planEdit é puro: não toca em nada e devolve a posição escolhida', () => {
  const plan = planEdit('x.js', CALC, { ...FIX, line: 2 });
  assert.equal(plan.chosen.line, 2);
  assert.equal(plan.matches, 2);
  assert.equal(plan.next.split('\n')[1], '  return a - b;');
  assert.equal(plan.next.split('\n')[5], '  return a + b;');
});
