/**
 * Espaço de trabalho de um agente: uma CÓPIA do projeto num diretório
 * temporário, acompanhada por um repositório git com um commit de base.
 * O diretório git fica FORA da árvore de trabalho, para que os comandos do
 * agente não o vejam nem o adulterem (o que esconderia alterações no diff).
 * O projeto original nunca é alterado; o resultado de uma execução é o
 * `git diff` deste espaço de trabalho.
 *
 * Todo o acesso a ficheiros feito pelas ferramentas passa por `resolve()`,
 * que impede saídas da raiz (`..`, caminhos absolutos, links simbólicos)
 * e aplica as listas de caminhos proibidos e sensíveis.
 */
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: 'path_denied' | 'not_found' | 'too_large' | 'invalid' | 'conflict' | 'failed' = 'failed',
  ) {
    super(message);
  }
}

export interface PathPolicy {
  /** Nunca legíveis (segredos, metadados internos). */
  readDeny: RegExp[];
  /** Nunca alteráveis (além de readDeny). */
  writeDeny: RegExp[];
  /** Alteração exige confirmação explícita. */
  sensitive: RegExp[];
}

export const DEFAULT_PATH_POLICY: PathPolicy = {
  readDeny: [
    /(^|\/)\.env(?!\.example$)(\..+)?$/i,
    /\.(pem|key|p12|pfx|jks|keystore)$/i,
    /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
    /(^|\/)\.(npmrc|netrc|pypirc)$/i,
    /(^|\/)\.(ssh|aws|gnupg|docker)(\/|$)/i,
    /^\.git(\/|$)/,
    /^\.forja(\/|$)/,
  ],
  writeDeny: [/(^|\/)node_modules(\/|$)/],
  sensitive: [
    /^package\.json$/,
    /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum)$/,
    /^\.github(\/|$)/,
    /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|Makefile)$/,
    /^\.gitignore$/,
  ],
};

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.forja', 'dist', 'build', 'coverage', '.next', '__pycache__', '.venv']);

export interface WorkspaceOptions {
  /** Diretório onde criar o espaço de trabalho (por defeito, o temporário do sistema). */
  baseDir?: string;
  policy?: PathPolicy;
  /** Caminhos adicionais cuja alteração exige confirmação (ex.: os testes de uma tarefa). */
  protectedPaths?: RegExp[];
}

const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'forja-agente',
  GIT_AUTHOR_EMAIL: 'agente@forja.local',
  GIT_COMMITTER_NAME: 'forja-agente',
  GIT_COMMITTER_EMAIL: 'agente@forja.local',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: tmpdir(),
};

export class Workspace {
  private constructor(
    readonly root: string,
    private readonly gitDir: string,
    readonly policy: PathPolicy,
    readonly protectedPaths: RegExp[],
    /** Ficheiros do projeto original não copiados por serem sensíveis. */
    readonly omitted: string[],
  ) {}

  /** Copia `sourceDir` (sem .git, node_modules, etc.) e cria o commit de base. */
  static async create(sourceDir: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    const src = await realpath(resolve(sourceDir));
    const base = options.baseDir ?? tmpdir();
    await mkdir(base, { recursive: true });
    const root = await realpath(await mkdtemp(join(base, 'forja-ws-')));
    const policy = options.policy ?? DEFAULT_PATH_POLICY;
    const omitted: string[] = [];
    await cp(src, root, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (from) => {
        const rel = relative(src, from).split(sep).join('/');
        if (!rel) return true;
        if (rel.split('/').some((part) => IGNORED_DIRS.has(part))) return false;
        // Segredos nem sequer são copiados: nem as ferramentas nem os comandos os veem.
        if (policy.readDeny.some((r) => r.test(rel))) {
          omitted.push(rel);
          return false;
        }
        return true;
      },
    });
    const gitDir = await realpath(await mkdtemp(join(base, 'forja-git-')));
    const ws = new Workspace(root, gitDir, policy, options.protectedPaths ?? [], omitted);
    ws.git(['init', '-q', '-b', 'base']);
    ws.stageAll();
    ws.git(['commit', '-q', '--allow-empty', '-m', 'base']);
    return ws;
  }

  /** Executa git no espaço de trabalho (sem hooks nem configuração do utilizador). */
  git(args: string[]): string {
    const r = this.gitRaw(args);
    if (r.status !== 0) throw new Error(`git ${args[0]} falhou: ${r.stderr.trim()}`);
    return r.stdout;
  }

  gitRaw(args: string[], timeoutMs = 60_000): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(
      'git',
      ['--git-dir', this.gitDir, '--work-tree', this.root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'safe.directory=*', '-c', 'core.quotepath=false', ...args],
      { cwd: this.root, env: GIT_ENV, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs },
    );
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : '') };
  }

  ignoredDirs(): ReadonlySet<string> {
    return IGNORED_DIRS;
  }

  /** Normaliza um caminho relativo vindo do modelo e verifica as regras sem tocar no disco. */
  normalize(input: unknown): string {
    if (typeof input !== 'string' || input.length === 0 || input.length > 500 || input.includes('\0')) {
      throw new ToolError('Caminho inválido.', 'invalid');
    }
    const p = posix.normalize(input.replace(/\\/g, '/').replace(/^\.\/+/, ''));
    if (p === '.' || p === '') return '.';
    if (p.startsWith('/') || p === '..' || p.startsWith('../') || /^[a-zA-Z]:/.test(p)) {
      throw new ToolError(`Caminho fora do espaço de trabalho: ${input}`, 'path_denied');
    }
    return p.replace(/\/$/, '');
  }

  isReadDenied(rel: string): boolean {
    return this.policy.readDeny.some((r) => r.test(rel));
  }

  isWriteDenied(rel: string): boolean {
    return this.isReadDenied(rel) || this.policy.writeDeny.some((r) => r.test(rel));
  }

  /** Motivo pelo qual uma escrita precisa de confirmação, ou null. */
  sensitivity(rel: string): string | null {
    if (this.policy.sensitive.some((r) => r.test(rel))) return `"${rel}" é um ficheiro sensível (configuração, dependências ou CI).`;
    if (this.protectedPaths.some((r) => r.test(rel))) return `"${rel}" está protegido nesta tarefa.`;
    return null;
  }

  /**
   * Caminho absoluto seguro para `input`. Verifica, pelo caminho real em disco,
   * que não sai da raiz (inclui links simbólicos em qualquer componente).
   */
  async resolve(input: unknown, mode: 'read' | 'write'): Promise<{ abs: string; rel: string }> {
    const rel = this.normalize(input);
    if (mode === 'read' ? this.isReadDenied(rel) : this.isWriteDenied(rel)) {
      throw new ToolError(`Acesso negado a "${rel}" pela política do espaço de trabalho.`, 'path_denied');
    }
    const abs = resolve(this.root, rel);
    // Componente existente mais próximo (para ficheiros que ainda não existem).
    let probe = abs;
    for (;;) {
      try {
        await lstat(probe);
        break;
      } catch {
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    const real = await realpath(probe).catch(() => probe);
    if (real !== this.root && !real.startsWith(this.root + sep)) {
      throw new ToolError(`Acesso negado: "${rel}" aponta para fora do espaço de trabalho.`, 'path_denied');
    }
    // O próprio alvo não pode ser um link simbólico (evita escrever através dele).
    if (probe === abs) {
      const st = await lstat(abs);
      if (st.isSymbolicLink()) throw new ToolError(`Acesso negado: "${rel}" é um link simbólico.`, 'path_denied');
    }
    return { abs, rel };
  }

  /**
   * Põe no índice (interno) todo o estado atual. Usa `-f` para que um
   * .gitignore do projeto não consiga esconder alterações do agente; só os
   * diretórios gerados (node_modules, dist, ...) ficam de fora.
   */
  stageAll(): void {
    const excludes = [...IGNORED_DIRS].map((d) => `:(exclude,glob)**/${d}/**`);
    this.git(['add', '-A', '-f', '--', '.', ...excludes]);
  }

  /** Ficheiros alterados desde a base (inclui novos e apagados). */
  changedFiles(): { status: string; path: string }[] {
    this.stageAll();
    return this.git(['diff', '--cached', '--name-status', '--no-renames', 'base'])
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [status = '', ...rest] = l.split('\t');
        return { status, path: rest.join('\t') };
      });
  }

  /** Diff unificado de todas as alterações desde a base. */
  diff(): string {
    this.stageAll();
    return this.git(['diff', '--cached', '--no-color', '--no-ext-diff', '--no-renames', 'base']);
  }

  /** Conteúdo de um ficheiro no commit de base (para verificar ficheiros protegidos). */
  baseContent(rel: string): string | null {
    try {
      return this.git(['show', `base:${rel}`]);
    } catch {
      return null;
    }
  }

  isIgnoredDir(name: string): boolean {
    return IGNORED_DIRS.has(name);
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
    await rm(this.gitDir, { recursive: true, force: true });
  }
}
