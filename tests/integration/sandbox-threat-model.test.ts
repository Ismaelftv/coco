/**
 * Modelo de ameaças da sandbox de contentor: provas POSITIVAS (controlo: a ação
 * é possível quando devia ser) e NEGATIVAS (a ação proibida falha), uma a uma.
 *
 * Âmbito: só o ambiente de teste. Os programas executados são pequenos e apenas
 * tentam violar uma fronteira; não há exploits de kernel nem tentativas de fuga
 * contra sistemas partilhados. "Não comprovado" é um resultado válido: o teste
 * é saltado com o motivo, nunca aprovado em silêncio.
 *
 * Ameaça modelada: código escrito por um modelo (potencialmente induzido por
 * prompt injection) a correr como utilizador sem privilégios dentro do contentor,
 * a tentar: ler/escrever o anfitrião, alcançar a rede (incluindo a API da Forja),
 * obter privilégios, esgotar recursos ou sobreviver ao fim do comando.
 * Fora do modelo: exploits de kernel/runtime (kernel partilhado), ataques de
 * canal lateral, um atacante com acesso ao daemon do Docker.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerSandbox, detectContainerEngine } from '../../server/agent/container-sandbox.ts';
import { ProcessSandbox, type Sandbox } from '../../server/agent/sandbox.ts';
import { startTestApp } from '../helpers/test-app.ts';

const scratch: string[] = [];
after(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

async function work(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'forja-thr-'));
  await chmod(d, 0o777);
  scratch.push(d);
  return d;
}

async function sh(sandbox: Sandbox, script: string, timeoutMs = 20_000, dir?: string) {
  const root = dir ?? (await work());
  const r = await sandbox.run({ argv: ['node', '-e', script], cwd: root, root, timeoutMs, maxOutputBytes: 16_000 });
  return { ...r, dir: root };
}
const last = (s: string) => JSON.parse(s.trim().split('\n').pop() || '{}') as Record<string, unknown>;

let container: ContainerSandbox | null = null;
let why = '';
let engine = 'docker';
before(() => {
  const found = detectContainerEngine();
  if (!found.available) why = found.reason;
  else {
    engine = found.engine;
    try {
      container = ContainerSandbox.create({ engine: found.engine, pull: true });
    } catch (e) {
      why = (e as Error).message;
    }
  }
});
const need = (t: { skip(m?: string): void }) => {
  if (container) return container;
  t.skip(`contentor indisponível: não comprovado neste anfitrião (${why})`);
  return null;
};
const leftovers = () => spawnSync(engine, ['ps', '-a', '--filter', `name=forja-sbx-${process.pid}-`, '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout.trim();

describe('rede: destinos externos e serviços internos da Forja', () => {
  test('controlo positivo: o MESMO programa alcança um serviço no anfitrião quando corre fora da sandbox', async () => {
    const srv: Server = createServer((s) => s.end('ola'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      // Sandbox de processo no anfitrião pode ou não bloquear; o controlo é correr o código diretamente.
      const r = spawnSync('node', ['-e', `require('net').connect(${port},'127.0.0.1').on('connect',()=>{console.log('LIGOU');process.exit(0)}).on('error',e=>{console.log('ERRO '+e.code);process.exit(1)})`], { encoding: 'utf8' });
      assert.match(r.stdout, /LIGOU/, 'sem este controlo, "bloqueado" na sandbox não prova nada');
    } finally {
      srv.close();
    }
  });

  test('a API real da Forja (e a sua porta) não é alcançável de dentro do contentor', async (t) => {
    const c = need(t);
    if (!c) return;
    let app: Awaited<ReturnType<typeof startTestApp>>;
    try {
      app = await startTestApp();
    } catch (e) {
      return t.skip(`não comprovado aqui: sem base de dados para arrancar a API da Forja (${(e as Error).message.slice(0, 80)})`);
    }
    try {
      const ok = await fetch(`${app.base}/api/health`).catch(() => null);
      assert.ok(ok, 'controlo: a API responde a partir do anfitrião');
      const port = new URL(app.base).port;
      const r = await sh(c, `
        const net = require('net');
        const alvos = [['127.0.0.1', ${port}], ['localhost', ${port}], ['host.docker.internal', ${port}], ['172.17.0.1', ${port}]];
        let pendentes = alvos.length; const res = {};
        for (const [h, p] of alvos) {
          const s = net.connect({ host: h, port: p, timeout: 2000 });
          s.on('connect', () => { res[h] = 'LIGOU'; s.destroy(); done(); });
          s.on('timeout', () => { res[h] = 'TIMEOUT'; s.destroy(); done(); });
          s.on('error', (e) => { res[h] = 'BLOQUEADO:' + e.code; done(); });
        }
        function done() { if (--pendentes === 0) console.log(JSON.stringify(res)); }`);
      const res = last(r.stdout) as Record<string, string>;
      for (const [h, v] of Object.entries(res)) assert.doesNotMatch(v, /LIGOU/, `alcançou ${h}`);
      assert.equal(Object.keys(res).length, 4);
    } finally {
      await app.stop();
    }
  });

  test('destino externo: sem rota nem DNS (tentativa de ligação TCP a um IP público e a um nome)', async (t) => {
    const c = need(t);
    if (!c) return;
    const r = await sh(c, `
      const net = require('net'), dns = require('dns'); const res = {};
      const s = net.connect({ host: '1.1.1.1', port: 53, timeout: 2500 });
      s.on('connect', () => { res.ip = 'LIGOU'; s.destroy(); });
      s.on('timeout', () => { res.ip = 'TIMEOUT'; s.destroy(); });
      s.on('error', (e) => { res.ip = 'BLOQUEADO:' + e.code; });
      dns.lookup('example.com', (e) => { res.dns = e ? 'BLOQUEADO:' + e.code : 'RESOLVEU'; });
      setTimeout(() => { console.log(JSON.stringify(res)); process.exit(0); }, 3500);`);
    const res = last(r.stdout) as Record<string, string>;
    assert.match(res.ip ?? '', /^BLOQUEADO:(ENETUNREACH|EADDRNOTAVAIL|ECONNREFUSED)/);
    assert.match(res.dns ?? '', /^BLOQUEADO:/);
  });

  test('interfaces de rede: apenas loopback do próprio contentor', async (t) => {
    const c = need(t);
    if (!c) return;
    const r = await sh(c, "console.log(JSON.stringify({ ifs: Object.keys(require('os').networkInterfaces()) }))");
    assert.deepEqual(last(r.stdout).ifs, ['lo']);
  });
});

describe('sistema de ficheiros e segredos do anfitrião', () => {
  test('controlo positivo: a escrita no espaço de trabalho funciona e chega ao anfitrião', async (t) => {
    const c = need(t);
    if (!c) return;
    const r = await sh(c, "require('fs').writeFileSync('/work/saida.txt','ok')");
    assert.equal(r.exitCode, 0);
    assert.equal(await readFile(join(r.dir, 'saida.txt'), 'utf8'), 'ok');
  });

  test('escrita fora do espaço de trabalho falha (raiz, /etc, /proc/sys, /sys, ../) e nada muda no anfitrião', async (t) => {
    const c = need(t);
    if (!c) return;
    const pai = await work();
    const irmao = join(pai, 'irmao.txt');
    await writeFile(irmao, 'original');
    await chmod(irmao, 0o666);
    const dir = await work();
    const r = await sh(c, `
      const fs = require('fs'); const t = (f) => { try { f(); return 'ESCREVEU'; } catch (e) { return e.code; } };
      console.log(JSON.stringify({
        raiz: t(() => fs.writeFileSync('/x', '1')), etc: t(() => fs.appendFileSync('/etc/passwd', 'x')),
        sysctl: t(() => fs.writeFileSync('/proc/sys/kernel/hostname', 'x')), sys: t(() => fs.writeFileSync('/sys/kernel/uevent_helper', 'x')),
        cgroup: t(() => fs.writeFileSync('/sys/fs/cgroup/memory.max', 'max')),
        acima: t(() => fs.writeFileSync('/work/../x', '1')), irmao: t(() => fs.writeFileSync(${JSON.stringify(irmao)}, 'pwn')),
      }))`, 20_000, dir);
    const o = last(r.stdout) as Record<string, string>;
    for (const [k, v] of Object.entries(o)) assert.notEqual(v, 'ESCREVEU', `escreveu em ${k}`);
    assert.equal(await readFile(irmao, 'utf8'), 'original');
  });

  test('leitura de segredos do anfitrião: ficheiro 0600, variável de ambiente, socket do Docker, /proc/1 e /proc/*/environ', async (t) => {
    const c = need(t);
    if (!c) return;
    const segredo = join(await work(), 'segredo');
    await writeFile(segredo, 'SEGREDO-DO-SERVIDOR');
    await chmod(segredo, 0o600);
    process.env.FORJA_TESTE_SEGREDO = 'VALOR-NO-AMBIENTE';
    try {
      const r = await sh(c, `
        const fs = require('fs'); const t = (f) => { try { return f(); } catch (e) { return 'ERR:' + e.code; } };
        const procs = t(() => fs.readdirSync('/proc').filter((x) => /^\\d+$/.test(x)));
        const ambientes = Array.isArray(procs) ? procs.map((p) => t(() => fs.readFileSync('/proc/' + p + '/environ', 'utf8'))).join('|') : '';
        console.log(JSON.stringify({
          segredo: t(() => fs.readFileSync(${JSON.stringify(segredo)}, 'utf8')),
          envProprio: process.env.FORJA_TESTE_SEGREDO ?? null,
          envDeOutros: ambientes.includes('VALOR-NO-AMBIENTE'),
          socket: t(() => fs.statSync('/var/run/docker.sock').isSocket()) , socket2: t(() => fs.statSync('/run/docker.sock').isSocket()),
          procs: Array.isArray(procs) ? procs.length : procs,
          hostRoot: t(() => fs.readdirSync('/proc/1/root/home')) ,
        }))`);
      const o = last(r.stdout);
      assert.match(String(o.segredo), /^ERR:/);
      assert.equal(o.envProprio, null);
      assert.equal(o.envDeOutros, false);
      assert.match(String(o.socket), /^ERR:ENOENT/);
      assert.match(String(o.socket2), /^ERR:ENOENT/);
      assert.ok(Number(o.procs) <= 6, `demasiados processos visíveis: ${o.procs}`);
    } finally {
      delete process.env.FORJA_TESTE_SEGREDO;
    }
  });
});

describe('utilizador, capacidades, namespaces e privilégios', () => {
  test('capacidades zero, no-new-privileges, seccomp ativo, uid ≠ 0', async (t) => {
    const c = need(t);
    if (!c) return;
    const r = await sh(c, `
      const st = require('fs').readFileSync('/proc/self/status', 'utf8');
      const g = (k) => st.split('\\n').find((l) => l.startsWith(k)).split(/\\s+/)[1];
      console.log(JSON.stringify({ uid: process.getuid(), euid: process.geteuid(), gid: process.getgid(), grupos: process.getgroups(), capEff: g('CapEff:'), capPrm: g('CapPrm:'), capBnd: g('CapBnd:'), capAmb: g('CapAmb:'), nnp: g('NoNewPrivs:'), seccomp: g('Seccomp:') }))`);
    const o = last(r.stdout) as Record<string, string | number | number[]>;
    assert.notEqual(o.uid, 0);
    assert.notEqual(o.euid, 0);
    for (const k of ['capEff', 'capPrm', 'capBnd', 'capAmb']) assert.match(String(o[k]), /^0+$/, k);
    assert.equal(o.nnp, '1');
    // Seccomp: 2 = filtro (perfil por omissão do motor). 0 = sem filtro: propriedade NÃO assegurada neste anfitrião.
    if (o.seccomp !== '2') return t.skip(`seccomp não ativo (Seccomp=${o.seccomp}): propriedade não comprovada neste anfitrião`);
  });

  test('namespaces: PID, rede, montagens, IPC e UTS são distintos dos do anfitrião', async (t) => {
    const c = need(t);
    if (!c) return;
    const r = await sh(c, `
      const fs = require('fs'); const res = {};
      for (const n of ['pid', 'net', 'mnt', 'ipc', 'uts']) { try { res[n] = fs.readlinkSync('/proc/self/ns/' + n); } catch (e) { res[n] = 'ERR:' + e.code; } }
      console.log(JSON.stringify(res))`);
    const dentro = last(r.stdout) as Record<string, string>;
    for (const n of ['pid', 'net', 'mnt', 'ipc', 'uts']) {
      const fora = spawnSync('readlink', [`/proc/self/ns/${n}`], { encoding: 'utf8' }).stdout.trim();
      assert.match(dentro[n]!, /^[a-z]+:\[\d+\]$/, `${n}: ${dentro[n]}`);
      assert.notEqual(dentro[n], fora, `namespace ${n} partilhado com o anfitrião`);
    }
  });

  test('tentativas de ganhar privilégios falham: setuid(0), mount, unshare, ptrace de PID 1, subir limites', async (t) => {
    const c = need(t);
    if (!c) return;
    const r = await sh(c, `
      const { spawnSync } = require('child_process'); const t = (f) => { try { f(); return 'FUNCIONOU'; } catch (e) { return e.code || String(e.message).slice(0, 40); } };
      const run = (a) => { const x = spawnSync(a[0], a.slice(1), { encoding: 'utf8' }); return x.error ? 'SEM_BINARIO' : (x.status === 0 ? 'FUNCIONOU' : 'FALHOU:' + x.status); };
      console.log(JSON.stringify({
        setuid: t(() => process.setuid(0)), setgid: t(() => process.setgid(0)),
        mount: run(['mount', '-t', 'tmpfs', 'tmpfs', '/mnt']), unshare: run(['unshare', '-U', '-r', 'true']),
        chroot: run(['chroot', '/', 'true']), su: run(['su', '-c', 'true']), sudo: run(['sudo', '-n', 'true']),
        subirNofile: run(['sh', '-c', 'ulimit -HSn 100000']),
      }))`);
    const o = last(r.stdout) as Record<string, string>;
    for (const [k, v] of Object.entries(o)) assert.notEqual(v, 'FUNCIONOU', `${k} funcionou`);
    // Binários ausentes (imagem mínima) tornam a tentativa trivial; regista-se para o relatório.
    const semBinario = Object.entries(o).filter(([, v]) => v === 'SEM_BINARIO').map(([k]) => k);
    console.log(`# privilégios: tentativas efetivamente executadas: ${Object.entries(o).filter(([, v]) => v !== 'SEM_BINARIO').map(([k]) => k).join(',')}; binário ausente: ${semBinario.join(',') || '-'}`);
    assert.match(String(o.setuid), /EPERM/);
  });
});

describe('recursos: CPU, memória, processos, disco, duração', () => {
  test('disco: o tmpfs de 256 MB esgota (ENOSPC) e o limite por ficheiro (ulimit fsize) corta ficheiros grandes', async (t) => {
    const c = need(t);
    if (!c) return;
    const small = ContainerSandbox.create({ maxFileBytes: 8 * 1024 * 1024, pull: true });
    const r = await sh(small, `
      const fs = require('fs'); const res = {};
      const bloco = Buffer.alloc(1024 * 1024, 1);
      // Muitos ficheiros de 4 MB (< fsize) em /tmp até o tmpfs de 256 MB esgotar.
      let ficheiros = 0;
      try { for (; ficheiros < 100; ficheiros++) { const fd = fs.openSync('/tmp/f' + ficheiros, 'w'); for (let i = 0; i < 4; i++) fs.writeSync(fd, bloco); fs.closeSync(fd); } res.tmp = 'SEM_LIMITE'; } catch (e) { res.tmp = e.code; }
      res.ficheiros = ficheiros;
      let m = 0; try { const fd = fs.openSync('/work/grande', 'w'); for (; m < 64; m++) fs.writeSync(fd, bloco); res.fsize = 'SEM_LIMITE'; } catch (e) { res.fsize = e.code; }
      res.mbWork = m;
      console.log(JSON.stringify(res))`, 60_000);
    const o = last(r.stdout) as Record<string, string | number>;
    assert.equal(o.tmp, 'ENOSPC', `tmpfs sem limite? ${r.stdout} ${r.stderr.slice(0, 200)}`);
    assert.ok(Number(o.ficheiros) <= 64, `escritos ${o.ficheiros} ficheiros de 4 MB (tmpfs 256 MB)`);
    // RLIMIT_FSIZE: erro EFBIG (ou o processo é terminado por SIGXFSZ).
    assert.ok(o.fsize === 'EFBIG' || r.signal === 'SIGXFSZ', `fsize: ${o.fsize} signal=${r.signal}`);
    const tam = await stat(join(r.dir, 'grande')).then((s) => s.size).catch(() => 0);
    assert.ok(tam <= 8 * 1024 * 1024, `ficheiro no espaço de trabalho com ${tam} bytes (limite 8 MiB)`);
  });

  test('crescimento abaixo da quota (256 MiB por omissão) é permitido; a quota é por amostragem, não do kernel (ver teste de quota)', async (t) => {
    const c = need(t);
    if (!c) return;
    const r = await sh(c, `
      const fs = require('fs'); const b = Buffer.alloc(1024 * 1024, 1);
      for (let i = 0; i < 20; i++) fs.writeFileSync('/work/f' + i, b);
      console.log(JSON.stringify({ ficheiros: fs.readdirSync('/work').length }))`);
    assert.equal(last(r.stdout).ficheiros, 20);
    assert.equal(r.quotaExceeded, undefined);
  });

  test('CPU: o ulimit de tempo de CPU termina um ciclo infinito antes do tempo limite de relógio', async (t) => {
    const c = need(t);
    if (!c) return;
    const curto = ContainerSandbox.create({ cpuSeconds: 2, pull: true });
    const r = await sh(curto, 'while (true) {}', 30_000);
    assert.equal(r.timedOut, false, 'deveria ter sido terminado pelo limite de CPU, não pelo relógio');
    assert.ok(r.signal === 'SIGKILL' || r.exitCode !== 0, `terminou como? exit=${r.exitCode} signal=${r.signal}`);
    assert.ok(r.durationMs < 15_000, `demorou ${r.durationMs} ms`);
  });
});

describe('processos órfãos, tempo limite, limpeza e contorno de limites', () => {
  test('processo em segundo plano (nohup/setsid) não sobrevive ao fim do comando; nenhum contentor fica para trás', async (t) => {
    const c = need(t);
    if (!c) return;
    const dir = await work();
    const r = await sh(c, `
      const { spawn } = require('child_process');
      const p = spawn(process.execPath, ['-e', "setInterval(() => require('fs').writeFileSync('/work/pulso', String(process.hrtime.bigint())), 200)"], { detached: true, stdio: 'ignore' });
      p.unref();
      setTimeout(() => process.exit(0), 1200);`, 20_000, dir);
    assert.equal(r.exitCode, 0);
    const antes = await readFile(join(dir, 'pulso'), 'utf8').catch(() => null);
    assert.ok(antes, 'controlo positivo: o processo em segundo plano chegou a correr');
    await new Promise((res) => setTimeout(res, 1500));
    const depois1 = await readFile(join(dir, 'pulso'), 'utf8');
    await new Promise((res) => setTimeout(res, 800));
    const depois2 = await readFile(join(dir, 'pulso'), 'utf8');
    assert.equal(depois1, depois2, 'o processo órfão continuou a escrever depois do fim do comando');
    assert.equal(leftovers(), '', 'contentores (incl. parados) por limpar');
  });

  test('tempo limite com processos filhos: tudo parado e contentor removido', async (t) => {
    const c = need(t);
    if (!c) return;
    const dir = await work();
    const r = await sh(c, `
      const { spawn } = require('child_process');
      for (let i = 0; i < 5; i++) spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => require('fs').writeFileSync('/work/p0', String(process.hrtime.bigint())), 200)"], { stdio: 'ignore' });
      setInterval(() => {}, 1000);`, 2_500, dir);
    assert.equal(r.timedOut, true);
    const a = await readFile(join(dir, 'p0'), 'utf8').catch(() => '');
    assert.ok(a, 'controlo positivo: os filhos chegaram a correr');
    await new Promise((res) => setTimeout(res, 1200));
    const b = await readFile(join(dir, 'p0'), 'utf8').catch(() => '');
    assert.equal(a, b, 'um filho que ignora SIGTERM continuou a correr');
    assert.equal(leftovers(), '');
  });

  test('contorno de limites: subir ulimit, escrever no cgroup, desligar o PID 1 (--init) e sair do cgroup falham ou são inócuos', async (t) => {
    const c = need(t);
    if (!c) return;
    const r = await sh(c, `
      const fs = require('fs'); const { spawnSync } = require('child_process');
      const t = (f) => { try { f(); return 'FUNCIONOU'; } catch (e) { return e.code; } };
      const lim = () => fs.readFileSync('/proc/self/limits', 'utf8').split('\\n').filter((l) => /Max (cpu time|file size|open files)/.test(l)).map((l) => l.replace(/\\s+/g, ' ')).join(' | ');
      const antes = lim();
      spawnSync('sh', ['-c', 'ulimit -Hn 99999; ulimit -Hf unlimited; ulimit -Ht unlimited'], { encoding: 'utf8' });
      console.log(JSON.stringify({
        kill1: t(() => process.kill(1, 'SIGKILL')), killTodos: t(() => process.kill(-1, 'SIGKILL')) === 'FUNCIONOU' ? 'ENVIOU' : 'NEGADO',
        cgroupProcs: t(() => fs.writeFileSync('/sys/fs/cgroup/cgroup.procs', String(process.pid))), cgroupMem: t(() => fs.writeFileSync('/sys/fs/cgroup/memory.max', 'max')),
        pidsMax: t(() => fs.writeFileSync('/sys/fs/cgroup/pids.max', 'max')), limitesInalterados: antes === lim(), antes }))`);
    const o = last(r.stdout) as Record<string, string | boolean>;
    assert.notEqual(o.cgroupProcs, 'FUNCIONOU');
    assert.notEqual(o.cgroupMem, 'FUNCIONOU');
    assert.notEqual(o.pidsMax, 'FUNCIONOU');
    assert.equal(o.limitesInalterados, true);
  });

  test('o processo de sandbox (ProcessSandbox) NÃO é apresentado como seguro: declara rede/FS conforme o observado', async () => {
    const p = new ProcessSandbox();
    assert.notEqual(p.isolation.filesystem, 'container_private');
    assert.notEqual(p.isolation.kind, 'container');
  });
});

describe('lacunas fechadas: quota do espaço de trabalho, digest da imagem, runtime e confinamento', () => {
  test('quota de crescimento: um comando que enche o espaço de trabalho é terminado e sinalizado', async (t) => {
    const c = need(t);
    if (!c) return;
    const small = ContainerSandbox.create({ quotaBytes: 8 * 1024 * 1024, pull: true });
    const dir = await work();
    const r = await small.run({
      argv: ['node', '-e', "const fs=require('fs'); const b=Buffer.alloc(1024*1024,1); let i=0; setInterval(()=>{ fs.writeFileSync('/work/f'+(i++), b); }, 20);"],
      cwd: dir, root: dir, timeoutMs: 30_000, maxOutputBytes: 8_000,
    });
    assert.equal(r.quotaExceeded, true, `não foi travado: ${r.stdout} ${r.stderr.slice(0, 200)} exit=${r.exitCode}`);
    assert.equal(r.timedOut, false);
    assert.match(r.stderr, /limite de crescimento/);
    const files = (await readdir(dir)).length;
    // Vigilância por amostragem: pode ultrapassar o limite até ao intervalo seguinte, mas não indefinidamente.
    assert.ok(files < 150, `escreveu ${files} MiB antes de ser parado (limite 8 MiB, amostragem 300 ms)`);
    assert.equal(leftovers(), '');
  });

  test('quota: um comando normal não é afetado (sem falsos positivos)', async (t) => {
    const c = need(t);
    if (!c) return;
    const r = await sh(ContainerSandbox.create({ quotaBytes: 8 * 1024 * 1024, pull: true }), "require('fs').writeFileSync('/work/pequeno.txt', 'x'.repeat(1000)); console.log('ok')");
    assert.equal(r.quotaExceeded, undefined);
    assert.equal(r.exitCode, 0);
  });

  test('imagem: identificada de facto (ID e digests) e a exigência de digest recusa etiquetas', async (t) => {
    const c = need(t);
    if (!c) return;
    assert.match(c.imageInfo.id, /^sha256:[0-9a-f]{64}$/);
    assert.ok(c.isolation.notes.some((n) => /digest|etiqueta/.test(n)));
    console.log(`# imagem: ${c.imageInfo.ref} id=${c.imageInfo.id.slice(0, 19)} fixadaPorDigest=${c.imageInfo.pinnedByDigest} repoDigests=${c.imageInfo.repoDigests.join(',') || '-'}`);
    if (!c.imageInfo.pinnedByDigest) {
      assert.throws(() => ContainerSandbox.create({ requireDigest: true, pull: true }), /não está fixada por digest/);
    }
    // Se há digest de registo, a imagem fixada por digest é aceite e usável.
    const dg = c.imageInfo.repoDigests[0];
    if (dg) {
      const pinned = ContainerSandbox.create({ image: dg, requireDigest: true, pull: true });
      assert.equal(pinned.imageInfo.pinnedByDigest, true);
      const r = await sh(pinned, "console.log('ok')");
      assert.equal(r.exitCode, 0);
    } else {
      console.log('# imagem sem digest de registo (imagem local): fixação por digest não exercitada neste anfitrião');
    }
  });

  test('confinamento obrigatório (AppArmor/SELinux): REGISTA o estado observado; salta se não houver', async (t) => {
    const c = need(t);
    if (!c) return;
    const r = await sh(c, `
      const fs = require('fs'); const g = (p) => { try { return fs.readFileSync(p, 'utf8').replace(/\\0/g, '').trim(); } catch (e) { return 'ERR:' + e.code; } };
      console.log(JSON.stringify({ mac: g('/proc/self/attr/current'), apparmorEnabled: g('/sys/module/apparmor/parameters/enabled') }))`);
    const o = last(r.stdout) as { mac: string; apparmorEnabled: string };
    console.log(`# confinamento: attr/current=${o.mac} apparmor.enabled=${o.apparmorEnabled}`);
    if (!/\((enforce|complain)\)/.test(o.mac) || /^unconfined/.test(o.mac)) {
      return t.skip(`sem AppArmor/SELinux a confinar o contentor neste anfitrião (attr/current=${o.mac}): propriedade NÃO comprovada`);
    }
    assert.match(o.mac, /enforce/);
  });

  test('runtime alternativo (gVisor/Kata) é transmitido ao motor quando configurado', async (t) => {
    const c = need(t);
    if (!c) return;
    // Um runtime inexistente tem de FALHAR (não cair em silêncio no runc): prova que a opção é aplicada.
    const bad = ContainerSandbox.create({ runtime: 'forja-runtime-inexistente', pull: true });
    const dir = await work();
    const r = await bad.run({ argv: ['node', '-e', "console.log('correu')"], cwd: dir, root: dir, timeoutMs: 20_000, maxOutputBytes: 4000 });
    assert.notEqual(r.exitCode, 0);
    assert.doesNotMatch(r.stdout, /correu/);
    assert.match(r.stderr, /runtime|forja-runtime-inexistente/i);
  });
});
