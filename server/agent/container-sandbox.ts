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
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  /** Runtime OCI alternativo, p. ex. `runsc` (gVisor) ou `kata`. Por omissão, o do motor (runc). */
  runtime?: string;
  /** Recusar imagens que não estejam referenciadas por digest (`nome@sha256:…`). Também via FORJA_SANDBOX_REQUIRE_DIGEST=1. */
  requireDigest?: boolean;
  /** Crescimento máximo, em bytes, do espaço de trabalho durante um comando (vigilância por amostragem; 0 desliga). */
  quotaBytes?: number;
}

const DIGEST_RE = /@sha256:[0-9a-f]{64}$/;
export const DEFAULT_QUOTA_BYTES = 256 * 1024 * 1024;

/** Espaço em disco ocupado por um diretório (como `du -sk`), em bytes. */
function diskUsage(dir: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('du', ['-sk', dir], { timeout: 10_000 }, (err, stdout) => {
      const kb = Number.parseInt(String(stdout).split(/\s/)[0] ?? '', 10);
      resolve(err || !Number.isFinite(kb) ? 0 : kb * 1024);
    });
  });
}

/**
 * Imagem por omissão: fixada por digest em config/sandbox-image.txt (observado na CI a 2026-10-19 para node:22-slim,
 * ver docs/08-isolamento.md). Se o ficheiro não existir, cai na etiqueta (e a sonda/notas dizem que NÃO está fixada).
 * Para atualizar a imagem: `docker pull node:22-slim`, ler o digest, rever e alterar o ficheiro num commit.
 */
function pinnedDefault(): string {
  try {
    const f = new URL('../../config/sandbox-image.txt', import.meta.url);
    const v = readFileSync(f, 'utf8').split('\n')[0]?.trim();
    if (v && DIGEST_RE.test(v)) return v;
  } catch {
    /* sem ficheiro */
  }
  return 'node:22-slim';
}
export const DEFAULT_SANDBOX_IMAGE = pinnedDefault();

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
  /** Identificação REAL da imagem usada (ID e digests do registo), para reprodutibilidade. */
  readonly imageInfo: { ref: string; id: string; repoDigests: string[]; pinnedByDigest: boolean };

  private constructor(engine: 'docker' | 'podman', private readonly options: ContainerSandboxOptions, info: { id: string; repoDigests: string[] }) {
    this.engine = engine;
    this.image = options.image ?? process.env.FORJA_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
    this.imageInfo = { ref: this.image, id: info.id, repoDigests: info.repoDigests, pinnedByDigest: DIGEST_RE.test(this.image) };
    this.name = `container:${engine}`;
    this.isolation = {
      kind: 'container',
      network: 'isolated',
      user: 'unprivileged',
      pidNamespace: true,
      filesystem: 'container_private',
      resourceLimits: true,
      envScrubbed: true,
      notes: [
        `Imagem ${this.image} (id ${info.id.slice(0, 19)}${info.repoDigests.length ? `, digest ${info.repoDigests[0]}` : ''}); ${this.imageInfo.pinnedByDigest ? 'fixada por digest' : 'referenciada por etiqueta (NÃO fixada por digest)'}.`,
        this.options.runtime ?? process.env.FORJA_SANDBOX_RUNTIME ? `Runtime: ${this.options.runtime ?? process.env.FORJA_SANDBOX_RUNTIME}.` : 'Runtime por omissão do motor (kernel partilhado com o servidor: não protege contra exploits de kernel; microVM ou gVisor seriam mais fortes).',
        'AppArmor/SELinux/seccomp: perfil por omissão do motor (observar na sonda).',
      ],
    };
  }

  /** Cria a sandbox se o motor existir e a imagem estiver disponível; lança com o motivo se não. */
  static create(options: ContainerSandboxOptions = {}): ContainerSandbox {
    const found = detectContainerEngine(options.engine);
    if (!found.available) throw new Error(`Motor de contentores indisponível (${found.reason}).`);
    const image = options.image ?? process.env.FORJA_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
    if ((options.requireDigest ?? process.env.FORJA_SANDBOX_REQUIRE_DIGEST === '1') && !DIGEST_RE.test(image)) {
      throw new Error(`Imagem "${image}" não está fixada por digest (exigido): usa nome@sha256:…`);
    }
    const have = engineCli(found.engine, ['image', 'inspect', image, '--format', '{{.Id}}']);
    if (have.status !== 0) {
      if (!options.pull) throw new Error(`Imagem "${image}" não existe localmente (use pull: true ou "${found.engine} pull ${image}").`);
      const pulled = engineCli(found.engine, ['pull', '-q', image], 300_000);
      if (pulled.status !== 0) throw new Error(`Não foi possível obter a imagem "${image}": ${pulled.stderr.trim().slice(0, 200)}`);
    }
    const insp = engineCli(found.engine, ['image', 'inspect', image, '--format', '{{.Id}}|{{json .RepoDigests}}']);
    const [id = '', digests = '[]'] = insp.stdout.trim().split('|');
    let repoDigests: string[] = [];
    try {
      repoDigests = (JSON.parse(digests) as string[] | null) ?? [];
    } catch {
      /* sem digests (imagem local) */
    }
    return new ContainerSandbox(found.engine, options, { id, repoDigests });
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
    const runtime = this.options.runtime ?? process.env.FORJA_SANDBOX_RUNTIME;
    const args = [
      'run', '--rm', '--name', name, '--init',
      ...(runtime ? ['--runtime', runtime] : []),
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
    let quotaExceeded = false;
    const quota = this.options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
    const baseline = quota > 0 ? await diskUsage(o.root) : 0;

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
      // Quota do espaço de trabalho: vigilância por amostragem (NÃO imposta pelo kernel): quem escreve
      // mais depressa do que o intervalo pode ultrapassar o limite antes de ser parado.
      let watching = quota > 0;
      const poll = async () => {
        while (watching) {
          await new Promise((r) => setTimeout(r, 300));
          if (!watching) break;
          const used = await diskUsage(o.root);
          if (watching && used - baseline > quota) {
            quotaExceeded = true;
            err.push(`\n[forja] limite de crescimento do espaço de trabalho excedido (+${Math.round((used - baseline) / 2 ** 20)} MiB > ${Math.round(quota / 2 ** 20)} MiB): comando terminado.`);
            kill();
            break;
          }
        }
      };
      if (quota > 0) void poll();
      child.stdout.setEncoding('utf8').on('data', (d: string) => out.push(d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => err.push(d));
      const finish = async (exitCode: number | null, signal: string | null, extraErr?: string) => {
        clearTimeout(timer);
        watching = false;
        o.signal?.removeEventListener('abort', onAbort);
        // Garante que não fica nada a correr (idempotente se o contentor já saiu).
        spawnSync(this.engine, ['rm', '-f', name], { timeout: 10_000, stdio: 'ignore' });
        if (timedOut || cancelled || quotaExceeded || extraErr) {
          // Se o limite chegou enquanto o motor ainda criava/arrancava o contentor, o `kill`/`rm` iniciais
          // podem ter corrido ANTES de ele existir e um contentor criado tarde ficaria a correr.
          // Repetir a remoção até o nome estar ausente durante 1 s seguido (máx. 5 s).
          const end = Date.now() + 5_000;
          let absentSince: number | null = null;
          while (Date.now() < end) {
            const ps = spawnSync(this.engine, ['ps', '-aq', '--filter', `name=^${name}$`], { encoding: 'utf8', timeout: 10_000 });
            if ((ps.stdout ?? '').trim() === '') {
              absentSince ??= Date.now();
              if (Date.now() - absentSince >= 1_000) break;
            } else {
              absentSince = null;
              spawnSync(this.engine, ['rm', '-f', name], { timeout: 10_000, stdio: 'ignore' });
            }
            await new Promise((r) => setTimeout(r, 150));
          }
        }
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
          ...(quotaExceeded ? { quotaExceeded: true } : {}),
        });
      };
      child.on('error', (e) => void finish(null, null, `Falha ao iniciar o motor de contentores: ${e.message}`));
      child.on('close', (code, sig) => void finish(code, sig));
    });
  }
}
