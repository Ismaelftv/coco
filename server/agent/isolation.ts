/**
 * Verificação COMPORTAMENTAL do isolamento de uma sandbox.
 *
 * Presença de binários (`unshare`, `docker`) não prova nada: no GitHub Actions
 * o `unshare` existe mas é bloqueado pelo AppArmor. Por isso a sonda corre, DENTRO
 * da sandbox, um programa que tenta de facto:
 *   - ligar-se a um servidor TCP que a sonda abriu no loopback do servidor;
 *   - ler um ficheiro 0600 do utilizador do servidor (segredo-isco);
 *   - ler um ficheiro legível por todos fora do espaço de trabalho;
 *   - escrever num diretório do servidor; ver o PID do servidor em /proc;
 *   - ler uma variável de ambiente do servidor; consultar os limites aplicados.
 * O nível resultante vem destes resultados, não do que a sandbox declara:
 *   none    — falha alguma garantia básica (rede, segredo, ambiente, limites);
 *   process — garantias básicas OK, mas partilha o sistema de ficheiros do
 *             servidor (aceitável só para código que o operador aceita arriscar);
 *   strong  — também não vê nem escreve no sistema de ficheiros do servidor,
 *             nem os seus processos, nem corre como root (contentor/microVM).
 * Só `strong` é aceite para projetos não confiáveis. Nem `strong` equivale a uma
 * microVM contra exploits de kernel.
 */
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sandbox } from './sandbox.ts';

export type IsolationLevel = 'none' | 'process' | 'strong';

export interface ProbeCheck {
  id: string;
  title: string;
  /** Nível mínimo para o qual esta garantia é exigida. */
  requiredFor: 'process' | 'strong' | 'info';
  passed: boolean;
  evidence: string;
}

export interface IsolationVerdict {
  sandbox: string;
  level: IsolationLevel;
  checks: ProbeCheck[];
  /** Garantias que a sandbox declara mas o comportamento desmente. */
  contradictions: string[];
  /** Falhou a própria execução da sonda. */
  error?: string;
  probedAt: string;
}

const CHILD_SCRIPT = String.raw`
const fs = require('fs'), net = require('net');
const P = JSON.parse(process.argv[1]);
const t = (f) => { try { return f(); } catch (e) { return 'ERR:' + (e.code || e.message); } };
const out = { uid: process.getuid(), cwd: process.cwd() };
out.secret = t(() => fs.readFileSync(P.secretFile, 'utf8'));
out.world = t(() => fs.readFileSync(P.worldFile, 'utf8'));
out.hostWrite = t(() => { fs.writeFileSync(P.writeDir + '/escrito', 'x'); return 'WROTE'; });
out.workWrite = t(() => { fs.writeFileSync('probe-escrita.txt', 'x'); return 'WROTE'; });
out.env = process.env.FORJA_PROBE_SEGREDO || null;
out.pidVisible = t(() => fs.readdirSync('/proc').includes(String(P.serverPid)));
out.cgroup = t(() => ({ memory: fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), pids: fs.readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim() }));
out.mac = t(() => fs.readFileSync('/proc/self/attr/current', 'utf8').replace(/\0/g, '').trim());
out.seccomp = t(() => (fs.readFileSync('/proc/self/status', 'utf8').split('\n').find((l) => l.startsWith('Seccomp:')) || '').split(/\s+/)[1] || 'desconhecido');
out.limits = t(() => fs.readFileSync('/proc/self/limits', 'utf8').split('\n').filter((l) => /^Max (cpu time|file size|processes|core file size)/.test(l)));
const tryConnect = (host) => new Promise((resolve) => {
  if (!host) return resolve('SEM_ENDERECO');
  const s = net.connect({ host, port: P.port, timeout: 1500 });
  s.on('connect', () => { s.destroy(); resolve('LIGOU'); });
  s.on('timeout', () => { s.destroy(); resolve('BLOQUEADO:timeout'); });
  s.on('error', (e) => resolve('BLOQUEADO:' + (e.code || e.message)));
});
(async () => {
  out.netLoopback = await tryConnect('127.0.0.1');
  out.netExternal = await tryConnect(P.externalIp);
  console.log('PROBE_JSON ' + JSON.stringify(out));
})();
`;

function externalIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

interface ChildReport {
  uid: number;
  cwd: string;
  secret: string;
  world: string;
  hostWrite: string;
  workWrite: string;
  env: string | null;
  pidVisible: boolean | string;
  limits: string[] | string;
  netLoopback: string;
  netExternal: string;
  mac?: string;
  seccomp?: string;
  cgroup: { memory: string; pids: string } | string;
}

const SECRET = 'SEGREDO-ISCO-DA-SONDA';
const WORLD = 'MARCA-LEGIVEL-DO-SERVIDOR';

export async function probeSandbox(sandbox: Sandbox, opts: { timeoutMs?: number } = {}): Promise<IsolationVerdict> {
  const probedAt = new Date().toISOString();
  const base = await mkdtemp(join(tmpdir(), 'forja-probe-'));
  const workspace = join(base, 'ws');
  const hostOnly = join(base, 'servidor');
  const writeDir = join(hostOnly, 'gravavel');
  await mkdir(workspace, { recursive: true });
  await mkdir(writeDir, { recursive: true });
  await chmod(base, 0o755);
  await chmod(hostOnly, 0o755);
  await chmod(writeDir, 0o755);
  const secretFile = join(hostOnly, 'segredo.txt');
  const worldFile = join(hostOnly, 'legivel.txt');
  await writeFile(secretFile, SECRET, { mode: 0o600 });
  await writeFile(worldFile, WORLD, { mode: 0o644 });
  await chmod(workspace, 0o777);

  const server = createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
  const port = (server.address() as { port: number }).port;
  process.env.FORJA_PROBE_SEGREDO = SECRET;
  try {
    const params = { secretFile, worldFile, writeDir, port, externalIp: externalIPv4(), serverPid: process.pid };
    const r = await sandbox.run({
      argv: ['node', '-e', CHILD_SCRIPT, JSON.stringify(params)],
      cwd: workspace,
      root: workspace,
      timeoutMs: opts.timeoutMs ?? 60_000,
      maxOutputBytes: 20_000,
    });
    const line = r.stdout.split('\n').find((l) => l.startsWith('PROBE_JSON '));
    if (!line) {
      return { sandbox: sandbox.name, level: 'none', checks: [], contradictions: [], error: `A sonda não produziu resultado (código ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`, probedAt };
    }
    return judge(sandbox, JSON.parse(line.slice('PROBE_JSON '.length)) as ChildReport, probedAt, process.getuid?.() ?? -1);
  } finally {
    delete process.env.FORJA_PROBE_SEGREDO;
    await new Promise<void>((r) => server.close(() => r()));
    await rm(base, { recursive: true, force: true });
  }
}

function judge(sandbox: Sandbox, c: ChildReport, probedAt: string, serverUid: number): IsolationVerdict {
  const blocked = (v: string) => v.startsWith('BLOQUEADO:') || v === 'SEM_ENDERECO';
  const denied = (v: string) => typeof v === 'string' && v.startsWith('ERR:');
  const limits = Array.isArray(c.limits) ? c.limits : [];
  const limitOf = (re: RegExp) => limits.find((l) => re.test(l)) ?? '';
  const finite = (l: string) => l !== '' && !/unlimited\s+unlimited/.test(l);
  const checks: ProbeCheck[] = [
    { id: 'rede_loopback', title: 'Não alcança o loopback do servidor', requiredFor: 'process', passed: blocked(c.netLoopback), evidence: c.netLoopback },
    { id: 'rede_externa', title: 'Não alcança o endereço de rede do servidor', requiredFor: 'process', passed: blocked(c.netExternal), evidence: c.netExternal },
    { id: 'segredo_0600', title: 'Não lê ficheiro 0600 do utilizador do servidor', requiredFor: 'process', passed: c.secret !== SECRET, evidence: c.secret === SECRET ? `LEU o segredo (uid do comando ${c.uid}, uid do servidor ${serverUid})` : c.secret },
    { id: 'ambiente_limpo', title: 'Não herda variáveis de ambiente do servidor', requiredFor: 'process', passed: c.env === null, evidence: c.env === null ? 'variável ausente' : 'HERDOU a variável do servidor' },
    { id: 'limites_cpu_ficheiro', title: 'Limites de CPU e tamanho de ficheiro aplicados', requiredFor: 'process', passed: finite(limitOf(/^Max cpu time/)) && finite(limitOf(/^Max file size/)), evidence: limits.map((l) => l.replace(/\s+/g, ' ')).join(' | ') || String(c.limits) },
    { id: 'espaco_trabalho_gravavel', title: 'Consegue gravar no espaço de trabalho', requiredFor: 'process', passed: c.workWrite === 'WROTE', evidence: c.workWrite },
    { id: 'fs_servidor_oculto', title: 'Não vê ficheiros do servidor fora do espaço de trabalho', requiredFor: 'strong', passed: c.world !== WORLD, evidence: c.world === WORLD ? 'LEU ficheiro legível por todos do servidor' : c.world },
    { id: 'fs_servidor_sem_escrita', title: 'Não escreve em diretórios do servidor', requiredFor: 'strong', passed: c.hostWrite !== 'WROTE', evidence: c.hostWrite },
    { id: 'processos_ocultos', title: 'Não vê os processos do servidor', requiredFor: 'strong', passed: c.pidVisible === false, evidence: c.pidVisible === false ? 'PID do servidor ausente de /proc' : String(c.pidVisible) },
    { id: 'memoria_limitada', title: 'Limite de memória (cgroup) aplicado — informativo', requiredFor: 'info', passed: typeof c.cgroup === 'object' && /^\d+$/.test(c.cgroup.memory), evidence: typeof c.cgroup === 'object' ? `memory.max=${c.cgroup.memory}` : String(c.cgroup) },
    { id: 'processos_limitados', title: 'Limite de processos (cgroup) aplicado — informativo', requiredFor: 'info', passed: typeof c.cgroup === 'object' && /^\d+$/.test(c.cgroup.pids), evidence: typeof c.cgroup === 'object' ? `pids.max=${c.cgroup.pids}` : String(c.cgroup) },
    { id: 'confinamento_mac', title: 'Confinamento obrigatório (AppArmor/SELinux) aplicado ao comando — informativo; não condiciona o nível', requiredFor: 'info', passed: typeof c.mac === 'string' && /\((enforce|complain)\)|container_t|docker-default|crio-default|cri-containerd/.test(c.mac) && !/^unconfined/.test(c.mac), evidence: `/proc/self/attr/current=${c.mac ?? 'n/d'}` },
    { id: 'seccomp_filtro', title: 'Filtro seccomp ativo (Seccomp: 2) — informativo; não condiciona o nível', requiredFor: 'info', passed: c.seccomp === '2', evidence: `Seccomp=${c.seccomp ?? 'n/d'}` },
    { id: 'sem_root', title: 'Não corre como root', requiredFor: 'strong', passed: c.uid !== 0, evidence: `uid ${c.uid}` },
  ];
  const basicOk = checks.filter((k) => k.requiredFor === 'process').every((k) => k.passed);
  const strongOk = basicOk && checks.filter((k) => k.requiredFor === 'strong').every((k) => k.passed);
  void denied;

  const d = sandbox.isolation;
  const byId = new Map(checks.map((k) => [k.id, k]));
  const contradictions: string[] = [];
  if (d.network === 'isolated' && !(byId.get('rede_loopback')!.passed && byId.get('rede_externa')!.passed)) contradictions.push('declara rede isolada, mas o comando alcançou o servidor');
  if (d.user === 'unprivileged' && !byId.get('segredo_0600')!.passed) contradictions.push('declara utilizador sem privilégios, mas leu um ficheiro 0600 do servidor');
  if (d.pidNamespace && !byId.get('processos_ocultos')!.passed) contradictions.push('declara namespace de PIDs, mas vê o PID do servidor');
  if (d.filesystem === 'container_private' && !byId.get('fs_servidor_oculto')!.passed) contradictions.push('declara sistema de ficheiros privado, mas lê ficheiros do servidor');
  if (d.resourceLimits && !byId.get('limites_cpu_ficheiro')!.passed) contradictions.push('declara limites de recursos, mas não estão aplicados');

  return { sandbox: sandbox.name, level: strongOk ? 'strong' : basicOk ? 'process' : 'none', checks, contradictions, probedAt };
}

/** Factos do anfitrião relevantes para perceber porque o isolamento falha (para o relatório de diagnóstico). */
export async function collectHostFacts(): Promise<Record<string, string>> {
  const { spawnSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const read = (p: string) => {
    try {
      return readFileSync(p, 'utf8').trim();
    } catch (e) {
      return `n/d (${(e as NodeJS.ErrnoException).code})`;
    }
  };
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8_000 });
    if (r.error) return `n/d (${(r.error as NodeJS.ErrnoException).code})`;
    return r.status === 0 ? 'ok' : `falhou (${r.status}): ${(r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 160)}`;
  };
  return {
    uid: String(process.getuid?.()),
    kernel: read('/proc/sys/kernel/osrelease'),
    'apparmor_restrict_unprivileged_userns': read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
    'unprivileged_userns_clone': read('/proc/sys/kernel/unprivileged_userns_clone'),
    'max_user_namespaces': read('/proc/sys/user/max_user_namespaces'),
    'unshare -n': run('unshare', ['-n', 'true']),
    'unshare -rn': run('unshare', ['-rn', 'true']),
    'unshare -n -p -f --mount-proc': run('unshare', ['-n', '-p', '-f', '--mount-proc', 'true']),
    'sudo -n': run('sudo', ['-n', 'true']),
    setpriv: run('setpriv', ['--version']),
    prlimit: run('prlimit', ['--version']),
    docker: run('docker', ['version', '--format', '{{.Server.Version}}']),
    podman: run('podman', ['version']),
    bwrap: run('bwrap', ['--version']),
  };
}
