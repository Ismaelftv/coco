/**
 * Execução isolada de comandos para os agentes.
 *
 * `ProcessSandbox` é um isolamento de PROCESSO, adequado a desenvolvimento e
 * avaliação, não a código hostil em produção. Aplica, quando o sistema permite:
 *   - rede desligada (namespace de rede próprio via `unshare -n`);
 *   - utilizador sem privilégios (`setpriv` para `nobody` quando corre como root);
 *   - limites de recursos (`prlimit`: CPU, tamanho de ficheiros, descritores, processos, core dumps);
 *   - ambiente limpo: só PATH/HOME/TMPDIR/LANG — nenhuma variável do servidor (segredos) passa;
 *   - HOME e TMPDIR próprios e temporários;
 *   - diretório de trabalho confinado ao espaço de trabalho;
 *   - tempo máximo com SIGKILL ao grupo de processos inteiro;
 *   - saída limitada (início e fim preservados).
 * O que NÃO garante: isolamento do sistema de ficheiros (o processo pode ler o
 * que o utilizador `nobody` puder ler), limite de memória fiável, nem proteção
 * contra falhas do kernel. Para produção é necessário uma microVM ou contentor
 * dedicado (ver docs/07-agentes.md). O relatório `isolation` diz sempre o que
 * foi efetivamente aplicado — nunca se declara isolamento que não existiu.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chown, mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, lstatSync, lchownSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * O que a sandbox DECLARA aplicar. É uma alegação, não uma garantia: as
 * garantias só existem depois de verificadas por comportamento (isolation.ts).
 */
export interface IsolationReport {
  kind: 'process' | 'container';
  network: 'isolated' | 'not_isolated';
  user: 'unprivileged' | 'same_as_server';
  /** Processos do servidor invisíveis ao comando (namespace de PIDs). */
  pidNamespace: boolean;
  /** `shared_host`: vê o sistema de ficheiros do servidor; `container_private`: só vê a imagem e o espaço de trabalho. */
  filesystem: 'shared_host' | 'container_private';
  resourceLimits: boolean;
  envScrubbed: true;
  notes: string[];
}

export interface SandboxRunOptions {
  argv: string[];
  /** Diretório absoluto onde correr (deve estar dentro do espaço de trabalho). */
  cwd: string;
  /** Raiz do espaço de trabalho (para ajustar permissões). */
  root: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Variáveis extra explicitamente permitidas (nunca herdadas do servidor). */
  env?: Record<string, string>;
}

export interface SandboxResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  isolation: IsolationReport;
}

export interface Sandbox {
  readonly name: string;
  readonly isolation: IsolationReport;
  run(options: SandboxRunOptions): Promise<SandboxResult>;
}

export interface ProcessSandboxOptions {
  /** Recusar correr se não for possível desligar a rede. */
  requireNetworkIsolation?: boolean;
  cpuSeconds?: number;
  maxFileBytes?: number;
  maxProcesses?: number;
  /** Heap máximo do Node em MB (via NODE_OPTIONS), porque o limite de memória virtual parte o V8. */
  nodeHeapMb?: number;
}

export const NOBODY = 65534;

export function canRun(argv: string[]): boolean {
  const r = spawnSync(argv[0]!, argv.slice(1), { stdio: 'ignore', timeout: 5_000 });
  return r.status === 0;
}

/** Saída limitada que guarda o início e o fim (o resumo dos testes costuma estar no fim). */
export class CappedBuffer {
  private head = '';
  private tail = '';
  private dropped = 0;
  constructor(private readonly max: number) {}
  push(s: string) {
    const half = Math.floor(this.max / 2);
    if (this.head.length < half) {
      const take = half - this.head.length;
      this.head += s.slice(0, take);
      s = s.slice(take);
    }
    if (!s) return;
    this.tail += s;
    if (this.tail.length > half) {
      this.dropped += this.tail.length - half;
      this.tail = this.tail.slice(-half);
    }
  }
  get truncated() {
    return this.dropped > 0;
  }
  toString() {
    return this.dropped > 0 ? `${this.head}\n[... ${this.dropped} caracteres omitidos ...]\n${this.tail}` : this.head + this.tail;
  }
}

export function chownTree(dir: string, uid: number, gid: number) {
  lchownSync(dir, uid, gid);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) chownTree(p, uid, gid);
    else lchownSync(p, uid, gid);
  }
}

export class ProcessSandbox implements Sandbox {
  readonly name = 'process';
  readonly isolation: IsolationReport;
  private readonly prefix: string[];
  private readonly dropPrivileges: boolean;

  constructor(private readonly options: ProcessSandboxOptions = {}) {
    const notes: string[] = [];
    const isRoot = process.getuid?.() === 0;
    let netPrefix: string[] = [];
    let pidNs = false;
    if (isRoot && canRun(['unshare', '-n', '-p', '-f', '--mount-proc', 'true'])) {
      netPrefix = ['unshare', '-n', '-p', '-f', '--mount-proc', '--'];
      pidNs = true;
    } else if (canRun(['unshare', '-n', 'true'])) netPrefix = ['unshare', '-n', '--'];
    else if (canRun(['unshare', '-rn', 'true'])) {
      netPrefix = ['unshare', '-rn', '--'];
      notes.push('Rede isolada com namespace de utilizador (o processo vê-se como root dentro do namespace, sem privilégios fora dele).');
    } else notes.push('Não foi possível criar um namespace de rede: os comandos TÊM acesso à rede.');

    const hasPrlimit = canRun(['prlimit', '--version']);
    if (!hasPrlimit) notes.push('prlimit indisponível: sem limites de CPU/ficheiros/processos.');
    this.dropPrivileges = isRoot && canRun(['setpriv', '--version']);
    if (!this.dropPrivileges) {
      notes.push(isRoot ? 'setpriv indisponível: os comandos correm como root.' : 'Os comandos correm com o mesmo utilizador (não root) do servidor.');
    }
    if (options.requireNetworkIsolation && netPrefix.length === 0) {
      throw new Error('Isolamento de rede obrigatório, mas indisponível neste sistema.');
    }

    const limits = hasPrlimit
      ? [
          'prlimit',
          `--cpu=${options.cpuSeconds ?? 120}`,
          `--fsize=${options.maxFileBytes ?? 64 * 1024 * 1024}`,
          '--nofile=512',
          `--nproc=${options.maxProcesses ?? 512}`,
          '--core=0',
          '--',
        ]
      : [];
    const drop = this.dropPrivileges ? ['setpriv', `--reuid=${NOBODY}`, `--regid=${NOBODY}`, '--clear-groups', '--'] : [];
    this.prefix = [...netPrefix, ...limits, ...drop];
    if (!pidNs) notes.push('Sem namespace de PIDs: o comando vê a lista de processos do servidor.');
    notes.push('Sistema de ficheiros do servidor visível (só leitura do que o utilizador do comando puder ler). Isolamento de processo, não de máquina.');
    this.isolation = {
      kind: 'process',
      network: netPrefix.length ? 'isolated' : 'not_isolated',
      user: this.dropPrivileges ? 'unprivileged' : 'same_as_server',
      pidNamespace: pidNs,
      filesystem: 'shared_host',
      resourceLimits: hasPrlimit,
      envScrubbed: true,
      notes,
    };
  }

  async run(o: SandboxRunOptions): Promise<SandboxResult> {
    if (o.argv.length === 0) throw new Error('Comando vazio.');
    const started = Date.now();
    const scratch = await mkdtemp(join(tmpdir(), 'forja-sbx-'));
    if (this.dropPrivileges) {
      await chown(scratch, NOBODY, NOBODY);
      chownTree(o.root, NOBODY, NOBODY);
    }
    const env: Record<string, string> = {
      PATH: [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
      HOME: scratch,
      TMPDIR: scratch,
      LANG: 'C.UTF-8',
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      NODE_OPTIONS: `--max-old-space-size=${this.options.nodeHeapMb ?? 1024}`,
      ...o.env,
    };
    const full = [...this.prefix, ...o.argv];
    const out = new CappedBuffer(o.maxOutputBytes);
    const err = new CappedBuffer(Math.max(1024, Math.floor(o.maxOutputBytes / 2)));
    let timedOut = false;
    let cancelled = false;

    try {
      return await new Promise<SandboxResult>((resolvePromise) => {
        const child = spawn(full[0]!, full.slice(1), { cwd: o.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const killGroup = () => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* já terminou */
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          killGroup();
        }, o.timeoutMs);
        const onAbort = () => {
          cancelled = true;
          killGroup();
        };
        o.signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.setEncoding('utf8').on('data', (d: string) => out.push(d));
        child.stderr.setEncoding('utf8').on('data', (d: string) => err.push(d));
        const finish = (exitCode: number | null, signal: string | null, extraErr?: string) => {
          clearTimeout(timer);
          o.signal?.removeEventListener('abort', onAbort);
          killGroup(); // processos órfãos que tenham ficado no grupo
          if (extraErr) err.push(extraErr);
          resolvePromise({
            exitCode,
            signal,
            timedOut,
            cancelled,
            stdout: out.toString(),
            stderr: err.toString(),
            truncated: out.truncated || err.truncated,
            durationMs: Date.now() - started,
            isolation: this.isolation,
          });
        };
        child.on('error', (e) => finish(null, null, `Falha ao iniciar o comando: ${e.message}`));
        child.on('close', (code, sig) => finish(code, sig));
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
