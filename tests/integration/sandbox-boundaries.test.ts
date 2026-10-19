/**
 * Fronteiras de segurança da execução de comandos.
 *
 * Princípios:
 *  - Cada garantia é verificada por COMPORTAMENTO (o comando tenta mesmo ler,
 *    ligar-se, escrever), nunca pela presença de binários.
 *  - O que a sandbox declara tem de coincidir com o que se observa: uma
 *    declaração desmentida é uma falha, não um aviso.
 *  - Quando o anfitrião não consegue oferecer uma garantia (p. ex. o runner do
 *    GitHub bloqueia namespaces de utilizador), o teste é SALTADO com o motivo
 *    explícito — nunca aprovado em silêncio — e o nível verificado fica reduzido.
 *  - Nenhum destes testes corre código não confiável: os comandos são pequenos
 *    programas escritos aqui que apenas tentam violar a fronteira.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerSandbox, detectContainerEngine } from '../../server/agent/container-sandbox.ts';
import { probeSandbox, type IsolationVerdict } from '../../server/agent/isolation.ts';
import { runAgent } from '../../server/agent/loop.ts';
import { ProcessSandbox, type Sandbox } from '../../server/agent/sandbox.ts';
import { detectCommands } from '../../server/agent/tools.ts';
import { Workspace } from '../../server/agent/workspace.ts';
import { createScriptedProvider, tool } from '../helpers/scripted-model.ts';

const PROJECTS = join(import.meta.dirname, '../../evals/agent/projetos');
const scratch: string[] = [];
const workspaces: Workspace[] = [];
after(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
  for (const w of workspaces) await w.dispose();
});

async function work(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'forja-bnd-'));
  await chmod(d, 0o777);
  scratch.push(d);
  return d;
}

async function sh(sandbox: Sandbox, script: string, timeoutMs = 20_000, env?: Record<string, string>) {
  const dir = await work();
  const r = await sandbox.run({ argv: ['node', '-e', script], cwd: dir, root: dir, timeoutMs, maxOutputBytes: 8_000, ...(env ? { env } : {}) });
  return { ...r, dir };
}

const processSandbox = new ProcessSandbox();
let container: ContainerSandbox | null = null;
let containerWhyNot = '';
const verdicts = new Map<string, IsolationVerdict>();

before(async () => {
  const found = detectContainerEngine();
  if (!found.available) containerWhyNot = found.reason;
  else {
    try {
      container = ContainerSandbox.create({ engine: found.engine, pull: true });
    } catch (e) {
      containerWhyNot = (e as Error).message;
    }
  }
  verdicts.set(processSandbox.name, await probeSandbox(processSandbox));
  if (container) verdicts.set(container.name, await probeSandbox(container));
  // Relatório legível nos logs: garantias reais deste anfitrião.
  for (const v of verdicts.values()) {
    console.log(`# isolamento verificado: ${v.sandbox} = ${v.level} | ${v.checks.filter((c) => c.requiredFor !== 'info' && !c.passed).map((c) => c.id).join(',') || 'sem falhas'}`);
  }
});

describe('sonda comportamental: declarado = observado', () => {
  test('processo: nenhuma declaração é desmentida pelo comportamento', () => {
    const v = verdicts.get('process')!;
    assert.equal(v.error, undefined);
    assert.deepEqual(v.contradictions, []);
  });

  test('processo: nunca é classificado como "strong" (partilha o sistema de ficheiros do servidor)', () => {
    const v = verdicts.get('process')!;
    assert.notEqual(v.level, 'strong');
    assert.equal(v.checks.find((c) => c.id === 'fs_servidor_oculto')!.passed, false, 'o processo lê ficheiros do servidor: isto tem de ser reportado');
  });

  test('processo: o nível verificado explica o que falta', (t) => {
    const v = verdicts.get('process')!;
    const failing = v.checks.filter((c) => c.requiredFor === 'process' && !c.passed);
    if (v.level === 'none') {
      assert.ok(failing.length > 0, 'nível none exige pelo menos uma garantia básica em falha');
      t.diagnostic(`Garantias básicas em falta: ${failing.map((c) => `${c.id} (${c.evidence})`).join('; ')}`);
    } else assert.equal(failing.length, 0);
  });

  test('contentor: nível "strong" verificado, sem contradições', (t) => {
    if (!container) return t.skip(`contentor indisponível neste anfitrião: ${containerWhyNot}`);
    const v = verdicts.get(container.name)!;
    assert.deepEqual(v.contradictions, []);
    assert.equal(v.level, 'strong', JSON.stringify(v.checks.filter((c) => !c.passed)));
  });
});

describe('processo: fronteiras individuais (só asseguradas quando o anfitrião as oferece)', () => {
  test('rede: sem acesso ao servidor TCP do anfitrião (loopback)', async (t) => {
    if (processSandbox.isolation.network !== 'isolated') return t.skip(`rede NÃO isolável neste anfitrião: ${processSandbox.isolation.notes.join(' ')}`);
    const srv: Server = createServer((s) => s.destroy());
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const r = await sh(processSandbox, `require('net').connect(${port}, '127.0.0.1').on('connect', () => { console.log('LIGOU'); process.exit(0) }).on('error', (e) => { console.log('BLOQUEADO ' + e.code); process.exit(0) })`);
      assert.match(r.stdout, /BLOQUEADO/);
    } finally {
      srv.close();
    }
  });

  test('utilizador: não lê um ficheiro 0600 do servidor, nem através de um link simbólico no espaço de trabalho', async (t) => {
    if (processSandbox.isolation.user !== 'unprivileged') return t.skip('o comando corre com o mesmo utilizador do servidor neste anfitrião: leitura de ficheiros do servidor NÃO é impedida');
    const secret = join(await work(), 'segredo');
    await writeFile(secret, 'SEGREDO', { mode: 0o600 });
    const dir = await work();
    await symlink(secret, join(dir, 'ligacao'));
    const r = await processSandbox.run({ argv: ['node', '-e', "try { console.log(require('fs').readFileSync('ligacao', 'utf8')) } catch (e) { console.log('NEGADO ' + e.code) }"], cwd: dir, root: dir, timeoutMs: 10_000, maxOutputBytes: 1000 });
    assert.match(r.stdout, /NEGADO EACCES/);
  });

  test('ambiente: variáveis do servidor não são herdadas', async () => {
    process.env.FORJA_SEGREDO_FRONTEIRA = 'nao-deve-passar';
    try {
      const r = await sh(processSandbox, 'console.log(JSON.stringify(Object.keys(process.env).sort()))');
      assert.ok(!r.stdout.includes('FORJA_SEGREDO_FRONTEIRA'));
      assert.ok(!r.stdout.includes('DATABASE_URL'));
    } finally {
      delete process.env.FORJA_SEGREDO_FRONTEIRA;
    }
  });
});

describe('contentor: fronteiras individuais', () => {
  const need = (t: { skip(m?: string): void }) => {
    if (container) return container;
    t.skip(`contentor indisponível neste anfitrião: ${containerWhyNot}`);
    return null;
  };

  test('sem rede: nem loopback do servidor, nem DNS', async (t) => {
    const c = need(t);
    if (!c) return;
    const srv: Server = createServer((s) => s.destroy());
    await new Promise<void>((r) => srv.listen(0, '0.0.0.0', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const r = await sh(c, `
        const net = require('net'), dns = require('dns');
        net.connect(${port}, '127.0.0.1').on('connect', () => console.log('LIGOU')).on('error', (e) => console.log('TCP_BLOQUEADO ' + e.code));
        dns.lookup('example.com', (e) => console.log(e ? 'DNS_BLOQUEADO ' + e.code : 'DNS_RESOLVEU'));
        setTimeout(() => process.exit(0), 3000);`);
      assert.match(r.stdout, /TCP_BLOQUEADO/);
      assert.match(r.stdout, /DNS_BLOQUEADO/);
      assert.doesNotMatch(r.stdout, /LIGOU|DNS_RESOLVEU/);
    } finally {
      srv.close();
    }
  });

  test('sistema de ficheiros: raiz só de leitura; o servidor não está montado; socket do Docker ausente', async (t) => {
    const c = need(t);
    if (!c) return;
    const hostFile = join(await work(), 'so-no-servidor.txt');
    await writeFile(hostFile, 'x');
    const r = await sh(c, `
      const fs = require('fs'); const t = (f) => { try { return f(); } catch (e) { return 'ERR:' + e.code; } };
      console.log(JSON.stringify({
        raiz: t(() => { fs.writeFileSync('/usr/violacao', 'x'); return 'ESCREVEU'; }),
        etc: t(() => { fs.writeFileSync('/etc/violacao', 'x'); return 'ESCREVEU'; }),
        tmp: t(() => { fs.writeFileSync('/tmp/ok', 'x'); return 'ESCREVEU'; }),
        servidor: t(() => fs.readFileSync(${JSON.stringify(hostFile)}, 'utf8')),
        docker: t(() => fs.statSync('/var/run/docker.sock').isSocket()),
        trabalho: t(() => { fs.writeFileSync('/work/ok.txt', 'x'); return 'ESCREVEU'; }),
      }))`);
    const o = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, string>;
    assert.equal(o.raiz, 'ERR:EROFS');
    assert.equal(o.etc, 'ERR:EROFS');
    assert.equal(o.tmp, 'ESCREVEU', '/tmp em memória é gravável');
    assert.equal(o.servidor, 'ERR:ENOENT');
    assert.equal(o.docker, 'ERR:ENOENT');
    assert.equal(o.trabalho, 'ESCREVEU');
    assert.equal(await readFile(join(r.dir, 'ok.txt'), 'utf8'), 'x', 'o que foi gravado no espaço de trabalho chega ao anfitrião');
  });

  test('privilégios: sem capacidades, sem root, no-new-privileges', async (t) => {
    const c = need(t);
    if (!c) return;
    const r = await sh(c, `
      const fs = require('fs');
      const st = fs.readFileSync('/proc/self/status', 'utf8');
      const get = (k) => st.split('\\n').find((l) => l.startsWith(k)).split(/\\s+/).slice(1).join(' ');
      console.log(JSON.stringify({ uid: process.getuid(), capEff: get('CapEff:'), capBnd: get('CapBnd:'), nnp: get('NoNewPrivs:') }))`);
    const o = JSON.parse(r.stdout.trim().split('\n').pop()!) as { uid: number; capEff: string; capBnd: string; nnp: string };
    assert.notEqual(o.uid, 0);
    assert.match(o.capEff, /^0+$/);
    assert.match(o.capBnd, /^0+$/);
    assert.equal(o.nnp, '1');
  });

  test('tempo limite MUITO curto (antes de o contentor existir): não fica nenhum contentor órfão', async (t) => {
    const c = need(t);
    if (!c) return;
    // 40 ms é menos do que o tempo de arranque do contentor: o `kill` chega antes de ele existir.
    for (let i = 0; i < 3; i++) {
      const r = await sh(c, 'setInterval(() => {}, 1000)', 40);
      assert.equal(r.timedOut, true);
    }
    await new Promise((res) => setTimeout(res, 2_500)); // um contentor criado tarde apareceria agora
    const engine = detectContainerEngine();
    const ps = spawnSync(engine.available ? engine.engine : 'docker', ['ps', '--filter', 'name=forja-sbx-', '--format', '{{.Names}}'], { encoding: 'utf8' });
    assert.equal(ps.stdout.trim(), '', 'ficou um contentor a correr depois de um tempo limite durante o arranque');
  });

  test('tempo limite: o contentor é realmente parado (nada fica a correr)', async (t) => {
    const c = need(t);
    if (!c) return;
    const r = await sh(c, 'setInterval(() => {}, 1000)', 1_500);
    assert.equal(r.timedOut, true);
    const engine = detectContainerEngine();
    const ps = spawnSync(engine.available ? engine.engine : 'docker', ['ps', '--filter', 'name=forja-sbx-', '--format', '{{.Names}}'], { encoding: 'utf8' });
    assert.equal(ps.stdout.trim(), '', 'contentor ainda a correr após o tempo limite');
  });

  test('limite de processos (cgroup): uma "fork bomb" é contida', async (t) => {
    const c = need(t);
    if (!c) return;
    const small = ContainerSandbox.create({ pidsLimit: 24, pull: true });
    const r = await sh(small, `
      const { spawn } = require('child_process'); let iniciados = 0, recusados = 0;
      for (let i = 0; i < 120; i++) {
        const p = spawn('sleep', ['4']);
        p.on('spawn', () => iniciados++);
        p.on('error', () => recusados++);
      }
      setTimeout(() => { console.log(JSON.stringify({ iniciados, recusados })); process.exit(0); }, 2000);`, 30_000);
    const out = JSON.parse(r.stdout.trim().split('\n').pop() || '{}') as { iniciados?: number; recusados?: number };
    // Se o cgroup de PIDs não existir neste anfitrião, o teste diz-o em vez de passar.
    if (typeof out.iniciados !== 'number') return assert.fail(`sem resultado: ${r.stdout} ${r.stderr.slice(0, 200)}`);
    if (out.recusados === 0 && out.iniciados >= 100) return t.skip(`limite de PIDs (cgroup) não aplicado neste anfitrião: ${out.iniciados} processos iniciados com limite 24`);
    assert.ok((out.iniciados ?? 0) <= 24, `processos iniciados: ${out.iniciados} (limite 24)`);
    assert.ok((out.recusados ?? 0) > 0);
  });

  test('limite de memória: alocação excessiva termina o comando', async (t) => {
    const c = need(t);
    if (!c) return;
    const small = ContainerSandbox.create({ memoryMb: 128, pull: true });
    const r = await sh(small, "const b = Buffer.alloc(900 * 1024 * 1024, 1); console.log('ALOCOU ' + b.length)", 30_000);
    if (/ALOCOU/.test(r.stdout)) return t.skip('limite de memória (cgroup) não aplicado neste anfitrião: a alocação de 900 MB com limite de 128 MB teve sucesso');
    assert.ok(r.exitCode !== 0);
  });
});

describe('porta de confiança: projetos não confiáveis só correm em sandbox verificada como "strong"', () => {
  async function attempt(trust: 'trusted' | 'untrusted' | undefined, verdict: IsolationVerdict | undefined, sandbox: Sandbox) {
    const ws = await Workspace.create(join(PROJECTS, 'calculadora'));
    workspaces.push(ws);
    const provider = createScriptedProvider([{ text: 'plano' }, tool('run_command', { name: 'test' })], { fallback: tool('finish', { summary: 'x' }) });
    const report = await runAgent({
      provider,
      model: { id: 'roteiro', label: 'roteiro', hosting: 'simulated' },
      workspace: ws,
      sandbox,
      commands: await detectCommands(ws.root),
      task: { goal: 'Corrige.', criteria: [{ type: 'command', name: 'test' }] },
      ...(trust ? { trust } : {}),
      ...(verdict ? { verdict } : {}),
      limits: { maxIterations: 3 },
    });
    return { report, provider };
  }

  test('por omissão é "untrusted": sem veredicto, recusa sem chamar o modelo nem executar comandos', async () => {
    const { report, provider } = await attempt(undefined, undefined, processSandbox);
    assert.equal(report.stopReason, 'sandbox_insufficient');
    assert.equal(report.status, 'failed');
    assert.equal(report.trust, 'untrusted');
    assert.equal(report.isolationLevel, 'unverified');
    assert.equal(provider.requests.length, 0, 'nenhum pedido ao modelo');
    assert.equal(report.commands.length + report.verification.length, 0, 'nenhum comando executado');
    assert.match(report.summary, /strong/);
  });

  test('untrusted + sandbox de processo (mesmo com veredicto "process") é recusado', async () => {
    const { report, provider } = await attempt('untrusted', verdicts.get('process'), processSandbox);
    assert.equal(report.stopReason, 'sandbox_insufficient');
    assert.equal(report.isolationLevel, verdicts.get('process')!.level);
    assert.equal(provider.requests.length, 0);
    assert.equal(report.verification.length, 0, 'os critérios de comando também não correm');
  });

  test('untrusted + veredicto forjado "strong" para a sandbox de processo: a sonda real desmente-o', async () => {
    // A porta confia no veredicto recebido; por isso o veredicto tem de vir SEMPRE de probeSandbox().
    const real = await probeSandbox(processSandbox);
    assert.notEqual(real.level, 'strong');
  });

  test('untrusted + contentor "strong": o agente arranca e corre os comandos dentro do contentor', async (t) => {
    if (!container) return t.skip(`contentor indisponível neste anfitrião: ${containerWhyNot}`);
    const { report, provider } = await attempt('untrusted', verdicts.get(container.name), container);
    assert.notEqual(report.stopReason, 'sandbox_insufficient');
    assert.ok(provider.requests.length > 0);
    assert.equal(report.isolationLevel, 'strong');
    assert.equal(report.isolation.kind, 'container');
    assert.ok(report.commands.length >= 1, 'os testes correram dentro do contentor');
    assert.equal(report.commands[0]!.exitCode, 1, 'a calculadora tem um bug: os testes falham, e isso foi observado');
  });

  test('trusted + processo: corre, mas o relatório regista o nível verificado e a confiança', async () => {
    const { report } = await attempt('trusted', verdicts.get('process'), processSandbox);
    assert.notEqual(report.stopReason, 'sandbox_insufficient');
    assert.equal(report.trust, 'trusted');
    assert.equal(report.isolationLevel, verdicts.get('process')!.level);
  });
});

test('ficheiros sensíveis nunca chegam ao espaço de trabalho, logo nunca a nenhuma sandbox', async () => {
  const ws = await Workspace.create(join(PROJECTS, 'injecao'));
  workspaces.push(ws);
  assert.ok(ws.omitted.includes('.env'));
  const sandbox = container ?? processSandbox;
  const r = await sandbox.run({ argv: ['node', '-e', "console.log(require('fs').existsSync('.env') ? 'EXISTE' : 'AUSENTE')"], cwd: ws.root, root: ws.root, timeoutMs: 20_000, maxOutputBytes: 1000 });
  assert.match(r.stdout, /AUSENTE/);
});

test('o espaço de trabalho recusa links simbólicos para fora mesmo que a sandbox os pudesse seguir', async () => {
  const dir = await work();
  await mkdir(join(dir, 'src'), { recursive: true });
  await symlink('/etc/hostname', join(dir, 'src', 'ligacao'));
  const ws = await Workspace.create(dir);
  workspaces.push(ws);
  await assert.rejects(ws.resolve('src/ligacao', 'read'), /fora do espaço de trabalho|link simbólico/);
  await assert.rejects(ws.resolve('src/ligacao', 'write'), /fora do espaço de trabalho|link simbólico/);
});
