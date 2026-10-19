/**
 * CI local da Forja — sem GitHub Actions.
 *
 *   npm run ci:local [-- --only a,b] [-- --skip a,b] [--db docker|local|external] [--strict] [--list]
 *
 * Corre, pela ordem: typecheck, unit, integration, sandbox, api-smoke, e2e, audit.
 * Usa os MESMOS comandos que .github/workflows/ci.yml. PostgreSQL: contentor Docker descartável
 * (por omissão), cluster local de scripts/pg-local.sh, ou um servidor externo (TEST_DATABASE_URL).
 *
 * Códigos de saída:  0 tudo correu e passou   1 há falhas
 *                    2 alguma suite NÃO pôde correr (Docker, rede, browser ausentes)
 *                    3 --strict e a suite de segurança teve testes ignorados
 *                    130 interrompido
 * Testes ignorados nunca contam como aprovados: aparecem no relatório com o motivo.
 * Isto NÃO é a CI do GitHub e não a substitui (ver docs/09-ci-local.md).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../server/db/db.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SANDBOX_FILES = ['sandbox-boundaries.test.ts', 'sandbox-threat-model.test.ts'];
const SUITE_ORDER = ['typecheck', 'unit', 'integration', 'sandbox', 'api-smoke', 'e2e', 'audit'] as const;
type SuiteId = (typeof SUITE_ORDER)[number];
type Status = 'passed' | 'passed_with_skips' | 'failed' | 'not_run' | 'excluded';

interface Skip { name: string; reason: string }
interface SuiteResult {
  id: SuiteId;
  title: string;
  command: string;
  status: Status;
  exitCode: number | null;
  durationMs: number;
  counts?: { tests: number; pass: number; fail: number; skipped: number; cancelled: number; todo: number };
  skips: Skip[];
  failures: string[];
  evidence: string[];
  note?: string;
  logFile?: string;
}

// ───────────────────────── argumentos ─────────────────────────
function parseArgs(argv: string[]) {
  const a = { only: [] as string[], skip: [] as string[], db: 'docker' as 'docker' | 'local' | 'external', strict: false, list: false, out: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => argv[++i] ?? '';
    if (k === '--only') a.only = v().split(',').filter(Boolean);
    else if (k === '--skip') a.skip = v().split(',').filter(Boolean);
    else if (k === '--db') a.db = v() as typeof a.db;
    else if (k === '--out') a.out = v();
    else if (k === '--strict') a.strict = true;
    else if (k === '--list') a.list = true;
    else if (k === '--help' || k === '-h') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]!.replace(/^\/\*\*\n|^ \* ?/gm, '')); process.exit(0); }
    else { console.error(`argumento desconhecido: ${k}`); process.exit(64); }
  }
  for (const s of [...a.only, ...a.skip]) if (!(SUITE_ORDER as readonly string[]).includes(s)) { console.error(`suite desconhecida: ${s} (válidas: ${SUITE_ORDER.join(', ')})`); process.exit(64); }
  if (!['docker', 'local', 'external'].includes(a.db)) { console.error('--db deve ser docker|local|external'); process.exit(64); }
  return a;
}

// ───────────────────────── utilitários ─────────────────────────
const sh = (cmd: string, args: string[], timeout = 20_000) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), error: r.error?.message };
};
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const fmt = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s` : `${(ms / 1000).toFixed(1)}s`);
const freePort = () => new Promise<number>((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); s.on('error', rej); });

let current: ChildProcess | undefined;
const killGroup = (c: ChildProcess | undefined, sig: NodeJS.Signals = 'SIGKILL') => { try { if (c?.pid) process.kill(-c.pid, sig); } catch { /* já terminou */ } };

interface RunOpts { env?: Record<string, string>; timeoutMs: number; logFile: string }
function run(argv: string[], o: RunOpts): Promise<{ code: number | null; timedOut: boolean; output: string; durationMs: number; spawnError?: string }> {
  return new Promise((resolveRun) => {
    const start = Date.now();
    const log = createWriteStream(o.logFile);
    let output = '';
    const child = spawn(argv[0]!, argv.slice(1), { cwd: ROOT, env: { ...process.env, ...o.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, o.timeoutMs);
    const onData = (b: Buffer) => { log.write(b); if (output.length < 30_000_000) output += b.toString('utf8'); };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); log.end(); resolveRun({ code: null, timedOut, output, durationMs: Date.now() - start, spawnError: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); killGroup(child); log.end(() => resolveRun({ code, timedOut, output, durationMs: Date.now() - start })); });
  });
}

/** Lê o resumo TAP do node:test. */
export function parseTap(output: string) {
  const last = (re: RegExp) => { const m = [...output.matchAll(re)]; return m.length ? Number(m[m.length - 1]![1]) : null; };
  const tests = last(/^# tests (\d+)/gm);
  const counts = tests === null ? undefined : {
    tests, pass: last(/^# pass (\d+)/gm) ?? 0, fail: last(/^# fail (\d+)/gm) ?? 0, skipped: last(/^# skipped (\d+)/gm) ?? 0,
    cancelled: last(/^# cancelled (\d+)/gm) ?? 0, todo: last(/^# todo (\d+)/gm) ?? 0,
  };
  const skips: Skip[] = [];
  for (const m of output.matchAll(/^\s*ok \d+ - (.+?) # SKIP\S*\s*(.*)$/gm)) skips.push({ name: m[1]!.trim(), reason: (m[2] ?? '').trim() || '(sem motivo declarado)' });
  const failures = [...output.matchAll(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm)].map((m) => m[1]!.trim()).slice(0, 25);
  return { counts, skips, failures };
}

// ───────────────────────── PostgreSQL ─────────────────────────
interface Pg { url: string; description: string; stop(): void }
const dockerOk = () => sh('docker', ['info', '--format', '{{.ServerVersion}}'], 15_000).code === 0;

async function waitDb(url: string, ms = 90_000) {
  const end = Date.now() + ms; let ok = 0; let last = '';
  while (Date.now() < end) {
    const db = createDb({ url, poolSize: 1 });
    try { await db.query('SELECT 1'); ok++; if (ok >= 2) { await db.close(); return; } } catch (e) { ok = 0; last = (e as Error).message; }
    await db.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`PostgreSQL não ficou disponível em ${ms / 1000}s: ${last}`);
}

function sweepStaleContainers() {
  const ids = sh('docker', ['ps', '-aq', '--filter', 'label=forja-ci=1', '--format', '{{.ID}} {{.Label "forja-ci-pid"}}']).out.split('\n').filter(Boolean);
  for (const line of ids) {
    const [id, pid] = line.split(' ');
    let alive = false;
    try { process.kill(Number(pid), 0); alive = true; } catch { /* morto */ }
    if (id && !alive) sh('docker', ['rm', '-f', id]);
  }
}

async function startPg(mode: 'docker' | 'local' | 'external'): Promise<Pg> {
  if (mode === 'external') {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('--db external exige TEST_DATABASE_URL');
    await waitDb(url, 15_000);
    return { url, description: 'servidor externo (TEST_DATABASE_URL)', stop() {} };
  }
  if (mode === 'local') {
    const wasUp = sh('bash', ['scripts/pg-local.sh', 'status']).code === 0;
    const r = sh('bash', ['scripts/pg-local.sh', 'start'], 120_000);
    if (r.code !== 0) throw new Error(`pg-local.sh falhou: ${r.out}`);
    const url = r.out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('postgres://')).pop() ?? '';
    if (!url) throw new Error(`pg-local.sh não devolveu um URL: ${r.out}`);
    await waitDb(url, 30_000);
    return { url, description: 'cluster local (scripts/pg-local.sh), PostgreSQL 16', stop() { if (!wasUp) sh('bash', ['scripts/pg-local.sh', 'stop'], 60_000); } };
  }
  if (!dockerOk()) throw new Error('o daemon Docker não responde (docker info falhou)');
  sweepStaleContainers();
  const image = process.env.FORJA_CI_PG_IMAGE ?? 'postgres:16';
  if (sh('docker', ['image', 'inspect', image]).code !== 0) {
    const pull = sh('docker', ['pull', image], 600_000);
    if (pull.code !== 0) throw new Error(`não foi possível obter a imagem ${image}: ${pull.out.split('\n').pop()}`);
  }
  const port = await freePort();
  const pass = randomBytes(12).toString('hex');
  const name = `forja-ci-pg-${process.pid}-${randomBytes(3).toString('hex')}`;
  const r = sh('docker', ['run', '-d', '--rm', '--name', name, '--label', 'forja-ci=1', '--label', `forja-ci-pid=${process.pid}`,
    '-e', 'POSTGRES_USER=forja', '-e', `POSTGRES_PASSWORD=${pass}`, '-e', 'POSTGRES_DB=postgres', '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
    '-p', `127.0.0.1:${port}:5432`, '--tmpfs', '/var/lib/postgresql/data:rw', '--shm-size', '256m', image, '-c', 'fsync=off', '-c', 'max_connections=200'], 60_000);
  if (r.code !== 0) throw new Error(`docker run falhou: ${r.out}`);
  const stop = () => { sh('docker', ['rm', '-f', name], 30_000); };
  const url = `postgres://forja:${pass}@127.0.0.1:${port}/postgres`;
  try { await waitDb(url); } catch (e) { stop(); throw e; }
  const id = sh('docker', ['image', 'inspect', image, '--format', '{{.Id}}']).out;
  return { url, description: `contentor ${name} (${image}, ${id.slice(0, 19)}), 127.0.0.1:${port}, dados em tmpfs`, stop };
}

// ───────────────────────── sandbox / browser ─────────────────────────
function resolveSandboxImage(): { ref?: string; id?: string; pinned: boolean; note: string } {
  const pinned = readFileSync(join(ROOT, 'config/sandbox-image.txt'), 'utf8').trim();
  const candidates = [process.env.FORJA_SANDBOX_IMAGE, pinned].filter(Boolean) as string[];
  if (!dockerOk()) return { pinned: false, note: 'Docker indisponível: os testes de contentor serão ignorados' };
  for (const ref of candidates) {
    if (sh('docker', ['image', 'inspect', ref]).code !== 0 && ref === pinned) sh('docker', ['pull', ref], 300_000);
    const info = sh('docker', ['image', 'inspect', ref, '--format', '{{.Id}}']);
    if (info.code === 0) return { ref, id: info.out, pinned: /@sha256:[0-9a-f]{64}$/.test(ref), note: ref === pinned ? 'imagem fixada por digest' : 'imagem indicada em FORJA_SANDBOX_IMAGE (NÃO é a fixada por digest)' };
  }
  return { pinned: false, note: `imagem ${pinned} indisponível (sem rede?): os testes de contentor serão ignorados` };
}

async function ensureChromium(): Promise<string | null> {
  try {
    const { chromium } = await import('playwright');
    if (existsSync(chromium.executablePath())) return null;
    const inst = sh('npx', ['playwright', 'install', 'chromium'], 600_000);
    return existsSync(chromium.executablePath()) ? null : `Chromium não instalado e a instalação falhou: ${inst.out.split('\n').pop()}`;
  } catch (e) { return `Playwright indisponível: ${(e as Error).message}`; }
}

// ───────────────────────── smoke da API real ─────────────────────────
async function apiSmoke(pgUrl: string, logFile: string): Promise<Pick<SuiteResult, 'status' | 'exitCode' | 'counts' | 'failures' | 'note' | 'evidence'>> {
  const dbName = `forja_smoke_${randomBytes(5).toString('hex')}`;
  const admin = createDb({ url: pgUrl, poolSize: 1 });
  const lines: string[] = []; const failures: string[] = []; let pass = 0;
  const check = (name: string, ok: boolean, detail = '') => { lines.push(`${ok ? 'ok' : 'not ok'} - ${name}${detail ? ` (${detail})` : ''}`); if (ok) pass++; else failures.push(name); };
  const storage = mkdtempSync(join(tmpdir(), 'forja-smoke-'));
  let child: ChildProcess | undefined;
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(pgUrl); u.pathname = `/${dbName}`;
    const port = await freePort();
    child = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: u.toString(), STORAGE_DIR: storage, SCRYPT_LOG_N: '12' },
    });
    let out = ''; child.stdout!.on('data', (b) => (out += b)); child.stderr!.on('data', (b) => (out += b));
    const exited = new Promise<number | null>((r) => child!.on('close', (c) => r(c)));
    let health = 0; const end = Date.now() + 40_000;
    while (Date.now() < end && health !== 200) {
      health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.status).catch(() => 0);
      if (health !== 200) await new Promise((r) => setTimeout(r, 400));
    }
    check('o servidor real (server/main.ts) arranca e /api/health responde 200', health === 200, `estado ${health}`);
    const noAuth = await fetch(`http://127.0.0.1:${port}/api/models`).then((r) => r.status).catch(() => 0);
    check('rota autenticada recusa pedido sem sessão (401)', noAuth === 401, `estado ${noAuth}`);
    killGroup(child, 'SIGTERM');
    const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000))]);
    check('SIGTERM encerra o servidor com código 0 em ≤10 s', code === 0, `código ${code}`);
    const closed = await fetch(`http://127.0.0.1:${port}/api/health`).then(() => false).catch(() => true);
    check('a porta fica fechada depois do encerramento', closed);
    lines.push('', '--- saída do servidor ---', out.trim());
  } catch (e) {
    check('smoke executou sem erro de infraestrutura', false, (e as Error).message);
  } finally {
    killGroup(child);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.close().catch(() => {});
    rmSync(storage, { recursive: true, force: true });
  }
  writeFileSync(logFile, lines.join('\n') + '\n');
  const total = 4;
  return { status: failures.length ? 'failed' : 'passed', exitCode: failures.length ? 1 : 0, counts: { tests: total, pass, fail: total - pass, skipped: 0, cancelled: 0, todo: 0 }, failures, evidence: [], note: 'arranque real do servidor contra o PostgreSQL de teste' };
}

// ───────────────────────── execução ─────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) { console.log(SUITE_ORDER.join('\n')); return 0; }
  const selected = SUITE_ORDER.filter((s) => (args.only.length ? args.only.includes(s) : true) && !args.skip.includes(s));
  const git = (a: string[]) => sh('git', a).out;
  const commit = git(['rev-parse', 'HEAD']);
  const dirtyList = git(['status', '--porcelain']).split('\n').filter(Boolean);
  const diffHash = sha256(git(['diff', 'HEAD']) + dirtyList.filter((l) => l.startsWith('??')).join('\n'));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const outDir = resolve(args.out || join(ROOT, 'resultados-local', `${stamp}-${commit.slice(0, 7)}${dirtyList.length ? '-dirty' : ''}`));
  mkdirSync(join(outDir, 'brutos'), { recursive: true });
  const started = Date.now();
  console.log(`CI local da Forja — commit ${commit.slice(0, 12)}${dirtyList.length ? ` (+${dirtyList.length} ficheiros alterados)` : ''}\nRelatórios: ${outDir}\n`);

  let pg: Pg | undefined; const cleanup = () => { try { pg?.stop(); } catch { /* melhor esforço */ } pg = undefined; };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { killGroup(current); cleanup(); console.error(`\n[${sig}] interrompido; serviços encerrados.`); process.exit(130); });
  process.on('exit', cleanup);

  const results: SuiteResult[] = [];
  const raw = (id: string) => join(outDir, 'brutos', `${id}.txt`);
  const notRun = (id: SuiteId, title: string, command: string, note: string): SuiteResult => ({ id, title, command, status: 'not_run', exitCode: null, durationMs: 0, skips: [], failures: [], evidence: [], note });

  const needsDb = selected.some((s) => ['integration', 'sandbox', 'api-smoke', 'e2e'].includes(s));
  let pgError = ''; let pgDesc = '';
  if (needsDb) {
    try { pg = await startPg(args.db); pgDesc = pg.description; console.log(`PostgreSQL: ${pgDesc}`); } catch (e) { pgError = (e as Error).message; console.error(`PostgreSQL indisponível: ${pgError}`); }
  }
  const sandbox = selected.some((s) => ['integration', 'sandbox'].includes(s)) ? resolveSandboxImage() : { pinned: false, note: 'não usada', ref: undefined as string | undefined, id: undefined as string | undefined };
  if (sandbox.ref) console.log(`Imagem do sandbox: ${sandbox.ref} — ${sandbox.note}`);
  else if (selected.includes('sandbox')) console.log(`AVISO: ${sandbox.note}`);
  const dbEnv: Record<string, string> = pg ? { TEST_DATABASE_URL: pg.url } : {};
  const sbEnv: Record<string, string> = sandbox.ref ? { FORJA_SANDBOX_IMAGE: sandbox.ref } : {};
  const node = process.execPath;
  const integrationFiles = readdirSync(join(ROOT, 'tests/integration')).filter((f) => f.endsWith('.test.ts') && !SANDBOX_FILES.includes(f)).sort().map((f) => `tests/integration/${f}`);

  const tap = async (id: SuiteId, title: string, argv: string[], env: Record<string, string>, timeoutMs: number, extra?: (r: SuiteResult, out: string) => void) => {
    const command = argv.map((a) => (a === node ? 'node' : a)).join(' ');
    console.log(`▶ ${id}: ${command}`);
    const r = await run(argv, { env, timeoutMs, logFile: raw(id) });
    const p = parseTap(r.output);
    const res: SuiteResult = { id, title, command, status: 'passed', exitCode: r.code, durationMs: r.durationMs, ...(p.counts ? { counts: p.counts } : {}), skips: p.skips, failures: p.failures, evidence: [], logFile: `brutos/${id}.txt` };
    if (r.spawnError) { res.status = 'not_run'; res.note = r.spawnError; }
    else if (r.timedOut) { res.status = 'failed'; res.note = `excedeu o limite de ${fmt(timeoutMs)}`; }
    else if (r.code !== 0 || (p.counts && (p.counts.fail > 0 || p.counts.cancelled > 0))) res.status = 'failed';
    else if (!p.counts || p.counts.tests === 0) { res.status = 'failed'; res.note = 'saída TAP não reconhecida ou 0 testes: não é possível confirmar que passou'; }
    else if (p.counts.skipped > 0) res.status = 'passed_with_skips';
    extra?.(res, r.output);
    return res;
  };
  const evidence = (res: SuiteResult, out: string) => { res.evidence = [...out.matchAll(/^\s*# \\?# (?:isolamento verificado|privilégios:|imagem:|confinamento:).*$/gm)].map((m) => m[0].replace(/^\s*# \\?# /, '').trim()).slice(0, 12); };

  for (const id of SUITE_ORDER) {
    if (!selected.includes(id)) {
      results.push({ ...notRun(id, id, '-', 'excluída pelo utilizador (--only/--skip)'), status: 'excluded' });
      continue;
    }
    const dbSuites = ['integration', 'sandbox', 'api-smoke', 'e2e'];
    let res: SuiteResult;
    if (dbSuites.includes(id) && !pg) {
      res = notRun(id, id, '-', `PostgreSQL indisponível: ${pgError}`);
    } else if (id === 'typecheck') {
      const command = 'npm run typecheck';
      console.log(`▶ typecheck: ${command}`);
      const r = await run(['npm', 'run', 'typecheck'], { timeoutMs: 300_000, logFile: raw(id) });
      res = { id, title: 'Verificação TypeScript', command, status: r.code === 0 ? 'passed' : 'failed', exitCode: r.code, durationMs: r.durationMs, skips: [], failures: r.code === 0 ? [] : r.output.split('\n').filter((l) => /error TS/.test(l)).slice(0, 15), evidence: [], logFile: 'brutos/typecheck.txt' };
      if (r.timedOut) { res.status = 'failed'; res.note = 'excedeu o limite'; }
    } else if (id === 'unit') {
      res = await tap(id, 'Testes unitários', ['npm', 'test'], {}, 300_000);
    } else if (id === 'integration') {
      res = await tap(id, 'Testes de integração (sem os da sandbox)', [node, '--import', 'tsx', '--test', ...integrationFiles], { ...dbEnv, ...sbEnv }, 1_200_000);
    } else if (id === 'sandbox') {
      res = await tap(id, 'Sandbox e fronteiras de segurança', [node, '--import', 'tsx', '--test', ...SANDBOX_FILES.map((f) => `tests/integration/${f}`)], { ...dbEnv, ...sbEnv }, 900_000, evidence);
      res.note = `${sandbox.note}${res.note ? `; ${res.note}` : ''}`;
    } else if (id === 'api-smoke') {
      console.log('▶ api-smoke: arranque real de server/main.ts');
      const t0 = Date.now();
      const s = await apiSmoke(pg!.url, raw(id));
      res = { id, title: 'Arranque da API real', command: 'node --import tsx server/main.ts (+ /api/health, SIGTERM)', skips: [], durationMs: Date.now() - t0, logFile: 'brutos/api-smoke.txt', ...s };
    } else if (id === 'e2e') {
      const miss = await ensureChromium();
      if (miss) res = notRun(id, 'Testes E2E (Playwright)', 'npm run test:e2e', miss);
      else {
        const shots = join(outDir, 'capturas-e2e'); mkdirSync(shots, { recursive: true });
        res = await tap(id, 'Testes E2E (Playwright)', ['npm', 'run', 'test:e2e'], { ...dbEnv, E2E_SCREENSHOTS: shots }, 900_000);
      }
    } else {
      const command = 'npm audit --audit-level=high --json';
      console.log(`▶ audit: ${command}`);
      const r = await run(['npm', 'audit', '--audit-level=high', '--json'], { timeoutMs: 180_000, logFile: raw(id) });
      let json: { error?: unknown; message?: string; metadata?: { vulnerabilities?: Record<string, number> } } = {};
      try { json = JSON.parse(r.output.slice(r.output.indexOf('{'))); } catch { /* sem JSON */ }
      const v = json.metadata?.vulnerabilities;
      res = { id, title: 'Auditoria de dependências', command, status: 'passed', exitCode: r.code, durationMs: r.durationMs, skips: [], failures: [], evidence: v ? [Object.entries(v).map(([k, n]) => `${k}: ${n}`).join(', ')] : [], logFile: 'brutos/audit.txt' };
      if (!v) { res.status = 'not_run'; res.note = `a auditoria não obteve resposta do registo (${json.message ?? r.output.slice(0, 160).replace(/\s+/g, ' ')}); NÃO significa "sem vulnerabilidades"`; }
      else if (r.code !== 0) { res.status = 'failed'; res.failures = [`vulnerabilidades de gravidade ≥ high: ${res.evidence[0]}`]; }
    }
    results.push(res);
    console.log(`   → ${res.status}${res.counts ? ` (${res.counts.pass}/${res.counts.tests} ok, ${res.counts.skipped} ignorados)` : ''} ${fmt(res.durationMs)}${res.note ? ` — ${res.note}` : ''}`);
  }
  cleanup();

  // ── veredicto e código de saída ──
  const failed = results.filter((r) => r.status === 'failed');
  const notRunList = results.filter((r) => r.status === 'not_run');
  const excluded = results.filter((r) => r.status === 'excluded');
  const sbx = results.find((r) => r.id === 'sandbox');
  const sbxSkips = sbx?.counts?.skipped ?? 0;
  const anySkips = results.some((r) => r.status === 'passed_with_skips');
  let exit = 0; let verdict: string;
  if (failed.length) { exit = 1; verdict = 'FALHOU'; }
  else if (notRunList.length) { exit = 2; verdict = 'INCOMPLETO (alguma suite não pôde correr)'; }
  else if (args.strict && sbxSkips > 0) { exit = 3; verdict = 'REPROVADO EM MODO ESTRITO (testes de segurança ignorados)'; }
  else if (excluded.length || anySkips) verdict = 'PASSOU COM RESERVAS (ver ignorados/excluídas)';
  else verdict = 'PASSOU';

  const ghStatus = JSON.parse(readFileSync(join(ROOT, 'config/github-ci-status.json'), 'utf8')) as { state: string; reason: string; since: string };
  const docker = sh('docker', ['version', '--format', '{{.Client.Version}} / servidor {{.Server.Version}}']).out;
  const report = {
    origem: 'LOCAL — não é a CI do GitHub e não a substitui',
    githubActions: ghStatus,
    commit, branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), dirty: dirtyList.length > 0, ficheirosAlterados: dirtyList.length, diffSha256: diffHash,
    iniciadoEm: new Date(started).toISOString(), duracaoMs: Date.now() - started, veredicto: verdict, codigoDeSaida: exit,
    ambiente: { node: process.version, npm: sh('npm', ['-v']).out, docker, so: `${platform()} ${release()}`, cpus: cpus().length, ramMB: Math.round(totalmem() / 1048576), postgres: pgDesc || (pgError ? `indisponível: ${pgError}` : 'não usado'), dbModo: needsDb ? args.db : 'não usado', sandboxImagem: sandbox.ref ? { ref: sandbox.ref, id: sandbox.id, fixadaPorDigest: sandbox.pinned, nota: sandbox.note } : { nota: sandbox.note } },
    suites: results,
  };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const icon: Record<Status, string> = { passed: '✅ passou', passed_with_skips: '⚠️ passou com ignorados', failed: '❌ falhou', not_run: '⛔ não correu', excluded: '➖ excluída' };
  const md = [
    `# CI local da Forja — ${verdict}`, '',
    `> **Resultado LOCAL.** Não é a CI do GitHub. GitHub Actions: **${ghStatus.state.toUpperCase()}** — ${ghStatus.reason} (desde ${ghStatus.since}).`, '',
    `- Commit testado: \`${commit}\` (${report.branch})${dirtyList.length ? ` — **árvore com ${dirtyList.length} ficheiro(s) alterado(s)**, diff sha256 \`${diffHash.slice(0, 16)}\`` : ' — árvore limpa'}`,
    `- Início: ${report.iniciadoEm}; duração total ${fmt(report.duracaoMs)}; código de saída **${exit}**`,
    `- Ambiente: node ${process.version}, npm ${report.ambiente.npm}, Docker ${docker || 'indisponível'}, ${report.ambiente.so}, ${report.ambiente.cpus} CPU, ${report.ambiente.ramMB} MB RAM`,
    `- PostgreSQL: ${report.ambiente.postgres} (modo ${needsDb ? args.db : '-'})`,
    `- Imagem do sandbox: ${sandbox.ref ? `\`${sandbox.ref}\` (${sandbox.note})` : sandbox.note}`, '',
    '| Suite | Estado | Testes | Ignorados | Duração |', '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${icon[r.status]} | ${r.counts ? `${r.counts.pass}/${r.counts.tests}` : '-'} | ${r.counts?.skipped ?? '-'} | ${r.durationMs ? fmt(r.durationMs) : '-'} |`), '',
  ];
  if (sbx) md.push('## Segurança da sandbox', '', sbx.status === 'passed' ? 'Todos os testes da suite foram executados e passaram (nenhum ignorado).' : sbx.status === 'passed_with_skips' ? `**Nem todas as propriedades foram comprovadas**: ${sbxSkips} teste(s) ignorado(s) (abaixo). As restantes passaram.` : `Estado: ${icon[sbx.status]}. **Os testes de segurança não estão aprovados.**`, '', ...sbx.evidence.map((e) => `- ${e}`), '');
  const withSkips = results.filter((r) => r.skips.length);
  if (withSkips.length) { md.push('## Testes ignorados', ''); for (const r of withSkips) for (const s of r.skips) md.push(`- **${r.id}** — ${s.name}: ${s.reason}`); md.push(''); }
  if (notRunList.length || excluded.length) { md.push('## Não executadas / excluídas', ''); for (const r of [...notRunList, ...excluded]) md.push(`- **${r.id}** (${r.status === 'excluded' ? 'excluída' : 'não correu'}): ${r.note}`); md.push(''); }
  if (failed.length) { md.push('## Falhas', ''); for (const r of failed) { md.push(`- **${r.id}**${r.note ? ` — ${r.note}` : ''}`); for (const f of r.failures) md.push(`  - ${f}`); } md.push(''); }
  md.push('## Comandos', '', ...results.filter((r) => r.command !== '-').map((r) => `- ${r.id}: \`${r.command.length > 200 ? `${r.command.slice(0, 200)}…` : r.command}\``), '', 'Resultados brutos em `brutos/`; dados completos em `report.json`.');
  writeFileSync(join(outDir, 'report.md'), md.join('\n') + '\n');
  try { const link = join(ROOT, 'resultados-local', 'ultimo'); rmSync(link, { force: true }); symlinkSync(outDir, link); } catch { /* opcional */ }

  console.log(`\n══ ${verdict} — código de saída ${exit} ══\n${results.map((r) => `${r.id.padEnd(10)} ${icon[r.status]}`).join('\n')}\nRelatório: ${join(outDir, 'report.md')}`);
  return exit;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
}
