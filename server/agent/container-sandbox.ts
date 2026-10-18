/**
 * Sandbox em contentor (Docker ou Podman) para código não confiável.
 *
 * Cada comando corre num contentor descartável:
 *   - sem rede (`--network none`);
 *   - sistema de ficheiros raiz só de leitura; só o espaço de trabalho (bind
 *     mount em /work) e um /tmp em memória são graváveis; o sistema de ficheiros
 *     do servidor não é montado;
 *   - sem capacidades (`--cap-drop ALL`), `no-new-privileges`, utilizador sem
 *     privilégios, namespace de PIDs próprio (isolado por omissão em contentores);
 *   - limites de memória, CPU, processos, tamanho de ficheiros e descritores;
 *   - ambiente limpo: só as variáveis que o servidor passar explicitamente.
 *
 * O socket do Docker nunca é montado. O núcleo (kernel) é partilhado com o
 * servidor: um contentor NÃO é tão forte como uma microVM (Firecracker/gVisor)
 * contra exploits de kernel. Ver docs/07-agentes.md. O que esta classe
 * declara só conta depois de verificado por `probeSandbox` (isolation.ts).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chownTree, NOBODY, CappedBuffer, type IsolationReport, type Sandbox, type SandboxResult, type SandboxRunOptions } from './sandbox.ts';

export interface ContainerSandboxOptions {
  /** `docker` (por omissão) ou `podman`. */
  engine?: 'docker' | 'podman';
  /** Imagem com as ferramentas do projeto (Node + npm por omissão). Fixar por digest em produção. */
  image?: string;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  cpuSeconds?: number;
  maxFileBytes?: number;
  /** Descarregar a imagem se não existir (precisa de rede no daemon, não no comando). */
  pull?: boolean;
}

export const DEFAULT_SANDBOX_IMAGE = 'node:22-slim';

function engineCli(engine: string, args: string[], timeoutMs = 15_000) {
  const r = spawnSync(engine, args, { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : '') };
}

export type ContainerAvailability = { available: true; engine: 'docker' | 'podman'; version: string } | { available: false; reason: string };

export function detectContainerEngine(prefer?: 'docker' | 'podman'): ContainerAvailability {
  const reasons: string[] = [];
  for (const engine of prefer ? [prefer] : (['docker', 'podman'] as const)) {
    const r = engineCli(engine, ['version', '--format', engine === 'docker' ? '{{.Server.Version}}' : '{{.Version}}']);
    if (r.status === 0 && r.stdout.trim()) return { available: true, engine, version: r.stdout.trim() };
    reasons.push(`${engine}: ${(r.stderr || 'não instalado').trim().split('\n')[0]!.slice(0, 160)}`);
  }
  return { available: false, reason: reasons.join('; ') };
}

export class ContainerSandbox implements Sandbox {
  readonly name: string;
  readonly isolation: IsolationReport;
  private readonly engine: string;
  private readonly image: string;

  private constructor(engine: 'docker' | 'podman', private readonly options: ContainerSandboxOptions) {
    this.engine = engine;
    this.image = options.image ?? process.env.FORJA_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
    this.name = `container:${engine}`;
    this.isolation = {
      kind: 'container',
      network: 'isolated',
      user: 'unprivileged',
      pidNamespace: true,
      filesystem: 'container_private',
      resourceLimits: true,
      envScrubbed: true,
      notes: [`Imagem ${this.image}. Kernel partilhado com o servidor: não protege contra exploits de kernel (microVM seria mais forte).`],
    };
  }

  /** Cria a sandbox se o motor existir e a imagem estiver disponível; lança com o motivo se não. */
  static create(options: ContainerSandboxOptions = {}): ContainerSandbox {
    const found = detectContainerEngine(options.engine);
    if (!found.available) throw new Error(`Motor de contentores indisponível (${found.reason}).`);
    const image = options.image ?? process.env.FORJA_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
    const have = engineCli(found.engine, ['image', 'inspect', image, '--format', '{{.Id}}']);
    if (have.status !== 0) {
      if (!options.pull) throw new Error(`Imagem "${image}" não existe localmente (use pull: true ou "${found.engine} pull ${image}").`);
      const pulled = engineCli(found.engine, ['pull', '-q', image], 300_000);
      if (pulled.status !== 0) throw new Error(`Não foi possível obter a imagem "${image}": ${pulled.stderr.trim().slice(0, 200)}`);
    }
    return new ContainerSandbox(found.engine, options);
  }

  async run(o: SandboxRunOptions): Promise<SandboxResult> {
    if (o.argv.length === 0) throw new Error('Comando vazio.');
    const started = Date.now();
    const isRoot = process.getuid?.() === 0;
    // Como root, o comando corre como "nobody"; senão, com o uid do servidor (continua sem privilégios no contentor).
    const uid = isRoot ? NOBODY : (process.getuid?.() ?? NOBODY);
    const gid = isRoot ? NOBODY : (process.getgid?.() ?? NOBODY);
    if (isRoot) chownTree(o.root, uid, gid);
    const name = `forja-sbx-${randomBytes(6).toString('hex')}`;
    const mem = `${this.options.memoryMb ?? 1024}m`;
    const env: Record<string, string> = {
      HOME: '/tmp',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      NODE_OPTIONS: '--max-old-space-size=768',
      ...o.env,
    };
    const args = [
      'run', '--rm', '--name', name, '--init',
      '--network', 'none',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', String(this.options.pidsLimit ?? 256),
      '--memory', mem, '--memory-swap', mem,
      '--cpus', String(this.options.cpus ?? 2),
      '--ulimit', `fsize=${this.options.maxFileBytes ?? 64 * 1024 * 1024}`,
      '--ulimit', 'nofile=512:512',
      '--ulimit', 'core=0',
      '--ulimit', `cpu=${this.options.cpuSeconds ?? 120}`,
      '--user', `${uid}:${gid}`,
      '--tmpfs', '/tmp:rw,nosuid,size=256m,mode=1777',
      '--mount', `type=bind,source=${o.root},target=/work`,
      '--workdir', '/work',
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      this.image,
      ...o.argv,
    ];
    const out = new CappedBuffer(o.maxOutputBytes);
    const err = new CappedBuffer(Math.max(1024, Math.floor(o.maxOutputBytes / 2)));
    let timedOut = false;
    let cancelled = false;

    return new Promise<SandboxResult>((resolvePromise) => {
      const child = spawn(this.engine, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const kill = () => {
        // Matar o cliente não pára o contentor: é preciso pedir ao motor.
        spawnSync(this.engine, ['kill', name], { timeout: 10_000, stdio: 'ignore' });
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, o.timeoutMs);
      const onAbort = () => {
        cancelled = true;
        kill();
      };
      o.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.setEncoding('utf8').on('data', (d: string) => out.push(d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => err.push(d));
      const finish = (exitCode: number | null, signal: string | null, extraErr?: string) => {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        // Garante que não fica nada a correr (idempotente se o contentor já saiu).
        spawnSync(this.engine, ['rm', '-f', name], { timeout: 10_000, stdio: 'ignore' });
        if (extraErr) err.push(extraErr);
        resolvePromise({
          // 137 = SIGKILL (inclui o OOM killer) → tratado como terminado por sinal.
          exitCode: exitCode === 137 ? null : exitCode,
          signal: exitCode === 137 ? 'SIGKILL' : signal,
          timedOut,
          cancelled,
          stdout: out.toString(),
          stderr: err.toString(),
          truncated: out.truncated || err.truncated,
          durationMs: Date.now() - started,
          isolation: this.isolation,
        });
      };
      child.on('error', (e) => finish(null, null, `Falha ao iniciar o motor de contentores: ${e.message}`));
      child.on('close', (code, sig) => finish(code, sig));
    });
  }
}
