/**
 * Ferramentas de programação dos agentes.
 *
 * Cada ferramenta declara: nome, descrição, esquema zod dos argumentos (validado
 * ANTES da execução), nível de risco e a função que a executa. A interface é
 * independente do modelo: o adaptador de protocolo (protocol.ts) converte as
 * definições para chamadas nativas ou para o protocolo textual.
 *
 * Princípios aplicados:
 *  - menor privilégio: todos os caminhos passam por Workspace.resolve();
 *    segredos não são copiados para o espaço de trabalho; comandos só por nome
 *    a partir de uma lista permitida, sem shell, dentro da sandbox;
 *  - confirmação explícita: apagar ficheiros, alterar ficheiros sensíveis ou
 *    protegidos, e comandos marcados como sensíveis;
 *  - limites: tamanho de leitura e escrita, número de resultados, saída dos comandos.
 */
import { lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { z } from 'zod';
import type { ToolSpec } from '../../shared/contract.ts';
import { commitAtomic, planEdit, type FileIO } from './edit.ts';
import { toJsonSchema } from './json-schema.ts';
import type { Sandbox, SandboxResult } from './sandbox.ts';
import { ToolError, type Workspace } from './workspace.ts';

/** Versão do conjunto de ferramentas: resultados com versões diferentes NÃO se misturam. 2 = edit_file recusa ocorrências ambíguas com lista, seleção por line/occurrence, escrita atómica verificada. */
export const TOOLS_VERSION = 2;

export type Risk = 'read' | 'write' | 'destructive' | 'execute';

export interface CommandSpec {
  /** Nome pelo qual o modelo pede o comando (ex.: "test"). */
  name: string;
  argv: string[];
  description: string;
  timeoutMs?: number;
  /** Aceitar argumentos extra do modelo (validados: sem opções, sem metacaracteres). */
  allowExtraArgs?: boolean;
  /** Pedir confirmação antes de cada execução. */
  requiresConfirmation?: boolean;
}

export interface ConfirmationRequest {
  tool: string;
  risk: Risk;
  reason: string;
  /** Resumo do que vai acontecer (caminho, comando, excerto da alteração). */
  details: string;
}

export interface ToolLimits {
  readFileBytes: number;
  readLines: number;
  writeFileBytes: number;
  listResults: number;
  searchResults: number;
  commandOutputBytes: number;
  commandTimeoutMs: number;
}

export const DEFAULT_TOOL_LIMITS: ToolLimits = {
  readFileBytes: 256 * 1024,
  readLines: 400,
  writeFileBytes: 256 * 1024,
  listResults: 300,
  searchResults: 60,
  commandOutputBytes: 16 * 1024,
  commandTimeoutMs: 120_000,
};

export interface CommandRecord {
  name: string;
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  /** Fim da saída combinada, como evidência no relatório. */
  outputTail: string;
}

export interface ToolContext {
  ws: Workspace;
  sandbox: Sandbox;
  commands: CommandSpec[];
  limits: ToolLimits;
  /** Devolve true só se um humano (ou política explícita) autorizar. */
  confirm(request: ConfirmationRequest): Promise<boolean>;
  signal: AbortSignal;
  /** Acesso a ficheiros (injetável nos testes para simular falhas de escrita). */
  io?: FileIO | undefined;
}

export interface ToolOutput {
  ok: boolean;
  /** Texto devolvido ao modelo (dados, não instruções). */
  content: string;
  changedFiles?: string[];
  command?: CommandRecord;
  /** Código de erro estável (para métricas e testes). */
  errorCode?: string;
}

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  risk: Risk;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

const ok = (content: string, extra: Partial<ToolOutput> = {}): ToolOutput => ({ ok: true, content, ...extra });

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // Um padrão sem "/" procura em qualquer diretório (como no .gitignore).
  return new RegExp(glob.includes('/') ? `^${re}$` : `(^|/)${re}$`);
}

async function walk(ws: Workspace, start: string, visit: (rel: string, size: number) => boolean): Promise<void> {
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop()!;
    const abs = dir === '.' ? ws.root : join(ws.root, dir);
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const e of entries) {
      const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
      if (ws.isReadDenied(rel)) continue;
      if (e.isDirectory()) {
        if (!ws.isIgnoredDir(e.name)) stack.push(rel);
      } else if (e.isFile()) {
        const st = await stat(join(ws.root, rel)).catch(() => null);
        if (!visit(rel, st?.size ?? 0)) return;
      }
      // Links simbólicos não são seguidos nem listados como ficheiros.
    }
  }
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

async function readText(ctx: ToolContext, path: string): Promise<{ rel: string; abs: string; text: string }> {
  const { abs, rel } = await ctx.ws.resolve(path, 'read');
  const st = await lstat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new ToolError(`Ficheiro não encontrado: ${rel}`, 'not_found');
  if (st.size > ctx.limits.readFileBytes) {
    throw new ToolError(`"${rel}" tem ${st.size} bytes; o limite de leitura é ${ctx.limits.readFileBytes}. Usa search_code para localizar o que precisas.`, 'too_large');
  }
  const buf = await readFile(abs);
  if (isBinary(buf)) throw new ToolError(`"${rel}" é um ficheiro binário.`, 'invalid');
  return { rel, abs, text: buf.toString('utf8') };
}

/** Leitura para edição: devolve também o buffer original e recusa o que não é UTF-8 válido (a reescrita corromperia bytes). */
async function readTextRaw(ctx: ToolContext, path: string): Promise<{ buf: Buffer; text: string }> {
  const { abs, rel } = await ctx.ws.resolve(path, 'read');
  const r = await readText(ctx, rel);
  const buf = await readFile(abs);
  if (!Buffer.from(r.text, 'utf8').equals(buf)) throw new ToolError(`"${rel}" não é UTF-8 válido: não é seguro editá-lo como texto.`, 'invalid');
  return { buf, text: r.text };
}

async function guardWrite(ctx: ToolContext, tool: string, rel: string, details: string, risk: Risk = 'write'): Promise<void> {
  const reason = risk === 'destructive' ? `Apagar "${rel}" é uma operação destrutiva.` : ctx.ws.sensitivity(rel);
  if (!reason) return;
  const allowed = await ctx.confirm({ tool, risk, reason, details });
  if (!allowed) throw new ToolError(`Operação não autorizada: ${reason} A confirmação foi recusada.`, 'path_denied');
}

function fileDiff(ctx: ToolContext, rel: string): string {
  ctx.ws.stageAll();
  const d = ctx.ws.git(['diff', '--cached', '--no-color', '-U2', 'base', '--', rel]);
  return d.length > 4000 ? `${d.slice(0, 4000)}\n[... diff truncado ...]` : d;
}

const path = (desc: string) => z.string().min(1).max(500).describe(desc);

const listFiles: ToolDefinition = {
  name: 'list_files',
  risk: 'read',
  description: 'Lista ficheiros do projeto (caminhos relativos e tamanho). Pode filtrar por um padrão glob, ex.: "*.ts" ou "src/**/*.test.js".',
  schema: z.object({
    path: path('Diretório a listar, relativo à raiz do projeto.').default('.'),
    pattern: z.string().max(200).optional().describe('Padrão glob opcional para filtrar ficheiros.'),
  }),
  async run(args: { path: string; pattern?: string | undefined }, ctx) {
    const { abs, rel } = await ctx.ws.resolve(args.path, 'read');
    const st = await stat(abs).catch(() => null);
    if (!st?.isDirectory()) throw new ToolError(`Diretório não encontrado: ${rel}`, 'not_found');
    const re = args.pattern ? globToRegExp(args.pattern) : null;
    const lines: string[] = [];
    let more = false;
    await walk(ctx.ws, rel, (file, size) => {
      if (re && !re.test(file)) return true;
      if (lines.length >= ctx.limits.listResults) {
        more = true;
        return false;
      }
      lines.push(`${file} (${size} B)`);
      return true;
    });
    if (lines.length === 0) return ok('Nenhum ficheiro encontrado.');
    return ok(lines.join('\n') + (more ? `\n[... lista limitada a ${ctx.limits.listResults} ficheiros; usa "pattern" ou "path" para restringir ...]` : ''));
  },
};

const readFileTool: ToolDefinition = {
  name: 'read_file',
  risk: 'read',
  description: 'Lê um ficheiro de texto com números de linha. Ficheiros longos são lidos por partes com startLine.',
  schema: z.object({
    path: path('Ficheiro a ler, relativo à raiz do projeto.'),
    startLine: z.number().int().min(1).default(1).describe('Primeira linha a devolver (1 = início).'),
  }),
  async run(args: { path: string; startLine: number }, ctx) {
    const { rel, text } = await readText(ctx, args.path);
    const all = text.split('\n');
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    const from = args.startLine - 1;
    if (from >= all.length && all.length > 0) throw new ToolError(`"${rel}" tem ${all.length} linhas.`, 'invalid');
    const slice = all.slice(from, from + ctx.limits.readLines);
    const body = slice.map((l, i) => `${String(from + i + 1).padStart(4)}| ${l}`).join('\n');
    const end = from + slice.length;
    const footer = end < all.length ? `\n[... linhas ${end + 1}-${all.length} por ler: usa startLine=${end + 1} ...]` : '';
    return ok(`${rel} (${all.length} linhas)\n${body}${footer}`);
  },
};

const searchCode: ToolDefinition = {
  name: 'search_code',
  risk: 'read',
  description: 'Procura texto no código (sem distinguir maiúsculas por defeito). Devolve ficheiro:linha: conteúdo. Usa para encontrar definições e referências.',
  schema: z.object({
    query: z.string().min(1).max(200).describe('Texto a procurar (ou expressão regular se regex=true).'),
    path: path('Diretório ou ficheiro onde procurar.').default('.'),
    regex: z.boolean().default(false).describe('Interpretar query como expressão regular estendida (POSIX).'),
    caseSensitive: z.boolean().default(false),
  }),
  async run(args: { query: string; path: string; regex: boolean; caseSensitive: boolean }, ctx) {
    const { rel } = await ctx.ws.resolve(args.path, 'read');
    // git grep: sem backtracking catastrófico, respeita binários, com tempo máximo.
    const r = ctx.ws.gitRaw(
      [
        'grep', '--untracked', '--no-exclude-standard', '-n', '-I', '--no-color', '--full-name',
        args.regex ? '-E' : '-F', ...(args.caseSensitive ? [] : ['-i']),
        '-e', args.query, '--', rel,
        ...[...ctx.ws.ignoredDirs()].map((d) => `:(exclude,glob)**/${d}/**`),
      ],
      10_000,
    );
    if (r.status === 1) return ok('Sem resultados.');
    if (r.status !== 0) throw new ToolError(`Pesquisa inválida: ${r.stderr.trim().slice(0, 300)}`, 'invalid');
    const hits = r.stdout.split('\n').filter(Boolean).filter((l) => {
      const file = l.slice(0, l.indexOf(':'));
      return !ctx.ws.isReadDenied(file);
    });
    if (hits.length === 0) return ok('Sem resultados.');
    const shown = hits.slice(0, ctx.limits.searchResults).map((l) => (l.length > 240 ? `${l.slice(0, 240)}…` : l));
    const more = hits.length > shown.length ? `\n[... mais ${hits.length - shown.length} resultados; refina a pesquisa ...]` : '';
    return ok(shown.join('\n') + more);
  },
};

const projectInfo: ToolDefinition = {
  name: 'project_info',
  risk: 'read',
  description: 'Resumo do projeto: linguagens, gestor de pacotes, dependências, scripts e comandos que podem ser executados com run_command.',
  schema: z.object({}),
  async run(_args: Record<string, never>, ctx) {
    const counts = new Map<string, number>();
    let files = 0;
    await walk(ctx.ws, '.', (rel) => {
      files++;
      const ext = posix.extname(rel) || posix.basename(rel);
      counts.set(ext, (counts.get(ext) ?? 0) + 1);
      return files < 20_000;
    });
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, n]) => `${e}: ${n}`);
    const out = [`Ficheiros: ${files}`, `Extensões: ${top.join(', ') || '—'}`];
    const pkg = await readFile(join(ctx.ws.root, 'package.json'), 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => null);
    if (pkg) {
      out.push(`package.json: ${String(pkg.name ?? '(sem nome)')}${pkg.type ? ` (type: ${String(pkg.type)})` : ''}`);
      for (const key of ['dependencies', 'devDependencies'] as const) {
        const deps = pkg[key] as Record<string, string> | undefined;
        if (deps && Object.keys(deps).length) out.push(`${key}: ${Object.entries(deps).map(([n, v]) => `${n}@${v}`).join(', ')}`);
      }
      const scripts = pkg.scripts as Record<string, string> | undefined;
      if (scripts) out.push(`scripts: ${Object.entries(scripts).map(([n, v]) => `${n}="${v}"`).join('; ')}`);
    }
    for (const f of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'tsconfig.json']) {
      if (await stat(join(ctx.ws.root, f)).catch(() => null)) out.push(`Encontrado: ${f}`);
    }
    if (ctx.ws.omitted.length) out.push(`Ficheiros sensíveis não disponíveis neste espaço de trabalho: ${ctx.ws.omitted.length}`);
    out.push(
      ctx.commands.length
        ? `Comandos disponíveis (run_command): ${ctx.commands.map((c) => `${c.name} — ${c.description} [${c.argv.join(' ')}]`).join('; ')}`
        : 'Nenhum comando disponível para execução.',
    );
    out.push(`Isolamento dos comandos: rede ${ctx.sandbox.isolation.network === 'isolated' ? 'desligada' : 'LIGADA'}, utilizador ${ctx.sandbox.isolation.user === 'unprivileged' ? 'sem privilégios' : 'igual ao do servidor'}.`);
    return ok(out.join('\n'));
  },
};

const editFile: ToolDefinition = {
  name: 'edit_file',
  risk: 'write',
  description:
    'Substitui um excerto exato de um ficheiro por outro. Se oldText aparecer mais de uma vez a edição é RECUSADA (nada é alterado) e recebes as linhas e o contexto de cada ocorrência: repete então com `line` (linha onde o excerto começa) ou com `occurrence` + `expectedMatches`. Se oldText não existir, nada é alterado. O ficheiro é escrito de forma atómica e verificado ao reabrir.',
  schema: z.object({
    path: path('Ficheiro a alterar.'),
    oldText: z.string().min(1).max(20_000).describe('Texto atual, copiado exatamente do ficheiro.'),
    newText: z.string().max(50_000).describe('Texto novo.'),
    line: z.number().int().min(1).optional().describe('Só quando oldText aparece várias vezes: linha (1-based) onde começa a ocorrência pretendida.'),
    occurrence: z.number().int().min(1).optional().describe('Alternativa a line: número da ocorrência (1-based) na lista devolvida; exige expectedMatches.'),
    expectedMatches: z.number().int().min(1).optional().describe('Número de ocorrências que viste na lista; a edição é recusada se o ficheiro já não tiver este número.'),
    version: z.string().max(40).optional().describe('Versão do ficheiro devolvida na lista de ocorrências; a edição é recusada se o ficheiro mudou.'),
  }),
  async run(args: { path: string; oldText: string; newText: string; line?: number | undefined; occurrence?: number | undefined; expectedMatches?: number | undefined; version?: string | undefined }, ctx) {
    const { abs, rel } = await ctx.ws.resolve(args.path, 'write');
    const { buf, text } = await readTextRaw(ctx, rel);
    const plan = planEdit(rel, text, args);
    if (Buffer.byteLength(plan.next) > ctx.limits.writeFileBytes) throw new ToolError('O ficheiro resultante excede o limite de escrita.', 'too_large');
    await guardWrite(ctx, 'edit_file', rel, `${rel}:${plan.chosen.line}\n- ${args.oldText.slice(0, 400)}\n+ ${args.newText.slice(0, 400)}`);
    await commitAtomic(abs, buf, Buffer.from(plan.next, 'utf8'), ctx.io);
    return ok(`Alteração aplicada em ${rel} (linha ${plan.chosen.line}, ${plan.matches > 1 ? `ocorrência escolhida de ${plan.matches}` : 'única ocorrência'}) e verificada ao reabrir o ficheiro.\n${fileDiff(ctx, rel)}`, { changedFiles: [rel] });
  },
};

const writeFileTool: ToolDefinition = {
  name: 'write_file',
  risk: 'write',
  description: 'Cria um ficheiro novo com o conteúdo indicado. Para substituir um ficheiro existente, indica overwrite=true (prefere edit_file para alterações parciais).',
  schema: z.object({
    path: path('Ficheiro a criar.'),
    content: z.string().max(256 * 1024).describe('Conteúdo completo do ficheiro.'),
    overwrite: z.boolean().default(false),
  }),
  async run(args: { path: string; content: string; overwrite: boolean }, ctx) {
    const { abs, rel } = await ctx.ws.resolve(args.path, 'write');
    if (Buffer.byteLength(args.content) > ctx.limits.writeFileBytes) throw new ToolError('Conteúdo excede o limite de escrita.', 'too_large');
    const existing = await lstat(abs).catch(() => null);
    if (existing && !existing.isFile()) throw new ToolError(`"${rel}" existe e não é um ficheiro.`, 'conflict');
    if (existing && !args.overwrite) throw new ToolError(`"${rel}" já existe. Usa edit_file ou overwrite=true.`, 'conflict');
    const before = existing ? await readFile(abs) : null;
    await guardWrite(ctx, 'write_file', rel, `${existing ? 'Substituir' : 'Criar'} ${rel} (${Buffer.byteLength(args.content)} bytes)`);
    await mkdir(dirname(abs), { recursive: true });
    await commitAtomic(abs, before, Buffer.from(args.content, 'utf8'), ctx.io);
    return ok(`${existing ? 'Substituído' : 'Criado'}: ${rel} (${args.content.split('\n').length} linhas).`, { changedFiles: [rel] });
  },
};

const deleteFile: ToolDefinition = {
  name: 'delete_file',
  risk: 'destructive',
  description: 'Apaga um ficheiro. Operação destrutiva: exige confirmação explícita do utilizador.',
  schema: z.object({ path: path('Ficheiro a apagar.') }),
  async run(args: { path: string }, ctx) {
    const { abs, rel } = await ctx.ws.resolve(args.path, 'write');
    const st = await lstat(abs).catch(() => null);
    if (!st?.isFile()) throw new ToolError(`Ficheiro não encontrado: ${rel}`, 'not_found');
    await guardWrite(ctx, 'delete_file', rel, `Apagar ${rel} (${st.size} bytes)`, 'destructive');
    await rm(abs);
    return ok(`Apagado: ${rel}.`, { changedFiles: [rel] });
  },
};

const SAFE_ARG = /^[A-Za-z0-9_./@:=+,-]{1,200}$/;

function tail(s: string, n: number): string {
  return s.length > n ? `[...]\n${s.slice(-n)}` : s;
}

export function summarizeRun(spec: CommandSpec, argv: string[], r: SandboxResult): { record: CommandRecord; text: string } {
  const combined = [r.stdout.trim(), r.stderr.trim() ? `--- stderr ---\n${r.stderr.trim()}` : ''].filter(Boolean).join('\n');
  const record: CommandRecord = {
    name: spec.name,
    argv,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    truncated: r.truncated,
    outputTail: tail(combined, 1500),
  };
  const status = r.timedOut
    ? `TEMPO ESGOTADO após ${r.durationMs} ms (processo terminado)`
    : r.exitCode === null
      ? `terminado pelo sinal ${r.signal ?? '?'}`
      : `código de saída ${r.exitCode}${r.exitCode === 0 ? ' (sucesso)' : ' (FALHOU)'}`;
  const text = `$ ${argv.join(' ')}\n${status}; ${r.durationMs} ms${r.truncated ? '; saída truncada' : ''}\n${combined || '(sem saída)'}`;
  return { record, text };
}

const runCommand: ToolDefinition = {
  name: 'run_command',
  risk: 'execute',
  description: 'Executa um comando permitido do projeto (ex.: testes) num ambiente isolado e devolve o código de saída e a saída. Só aceita nomes listados por project_info.',
  schema: z.object({
    name: z.string().min(1).max(60).describe('Nome do comando permitido (ex.: "test").'),
    args: z.array(z.string().max(200)).max(10).default([]).describe('Argumentos extra, apenas se o comando os aceitar (ex.: um ficheiro de teste).'),
  }),
  async run(args: { name: string; args: string[] }, ctx) {
    const spec = ctx.commands.find((c) => c.name === args.name);
    if (!spec) {
      throw new ToolError(`Comando "${args.name}" não permitido. Disponíveis: ${ctx.commands.map((c) => c.name).join(', ') || 'nenhum'}.`, 'path_denied');
    }
    if (args.args.length && !spec.allowExtraArgs) throw new ToolError(`O comando "${spec.name}" não aceita argumentos extra.`, 'invalid');
    for (const a of args.args) {
      if (!SAFE_ARG.test(a) || a.startsWith('-') || a.split('/').includes('..')) {
        throw new ToolError(`Argumento recusado: "${a}". Só caminhos e nomes simples, sem opções.`, 'invalid');
      }
    }
    const argv = [...spec.argv, ...args.args];
    if (spec.requiresConfirmation) {
      const allowed = await ctx.confirm({ tool: 'run_command', risk: 'execute', reason: `O comando "${spec.name}" exige confirmação.`, details: argv.join(' ') });
      if (!allowed) throw new ToolError('Execução não autorizada: a confirmação foi recusada.', 'path_denied');
    }
    const r = await ctx.sandbox.run({
      argv,
      cwd: ctx.ws.root,
      root: ctx.ws.root,
      timeoutMs: Math.min(spec.timeoutMs ?? ctx.limits.commandTimeoutMs, ctx.limits.commandTimeoutMs),
      maxOutputBytes: ctx.limits.commandOutputBytes,
      signal: ctx.signal,
    });
    const { record, text } = summarizeRun(spec, argv, r);
    // Um comando que falha não é um erro da ferramenta: o resultado é informação útil.
    return { ok: true, content: text, command: record };
  },
};

export const FINISH_TOOL = 'finish';

const finishTool: ToolDefinition = {
  name: FINISH_TOOL,
  risk: 'read',
  description: 'Termina a tarefa. Usa só depois de validar o trabalho (ex.: testes a passar). Indica um resumo do que foi feito e das evidências.',
  schema: z.object({ summary: z.string().min(1).max(4000).describe('O que foi feito, ficheiros alterados e resultado da validação.') }),
  async run(args: { summary: string }) {
    return ok(args.summary);
  },
};

export const BUILTIN_TOOLS: ToolDefinition[] = [projectInfo, listFiles, readFileTool, searchCode, editFile, writeFileTool, deleteFile, runCommand, finishTool];

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = BUILTIN_TOOLS) {
    for (const t of tools) {
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(t.name)) throw new Error(`Nome de ferramenta inválido: ${t.name}`);
      if (this.byName.has(t.name)) throw new Error(`Ferramenta duplicada: ${t.name}`);
      this.byName.set(t.name, t);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.byName.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.byName.values()];
  }

  /** Subconjunto permitido para uma tarefa (menor privilégio). */
  restrict(allowed: string[] | undefined): ToolRegistry {
    if (!allowed) return this;
    const set = new Set([...allowed, FINISH_TOOL]);
    return new ToolRegistry(this.list().filter((t) => set.has(t.name)));
  }

  specs(): ToolSpec[] {
    return this.list().map((t) => ({ name: t.name, description: t.description, parameters: toJsonSchema(t.schema) }));
  }

  /** Valida os argumentos e executa. Nunca lança: erros tornam-se resultados para o modelo. */
  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const tool = this.byName.get(name);
    if (!tool) {
      return { ok: false, errorCode: 'unknown_tool', content: `Ferramenta desconhecida: "${name}". Disponíveis: ${[...this.byName.keys()].join(', ')}.` };
    }
    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(argumentos)'}: ${i.message}`).join('; ');
      return { ok: false, errorCode: 'invalid_arguments', content: `Argumentos inválidos para ${name}: ${issues}` };
    }
    try {
      return await tool.run(parsed.data, ctx);
    } catch (e) {
      if (e instanceof ToolError) return { ok: false, errorCode: e.code, content: e.message };
      return { ok: false, errorCode: 'failed', content: `A ferramenta ${name} falhou: ${(e as Error).message}` };
    }
  }
}

/** Comandos por defeito a partir do package.json (só "test", com o runner do projeto). */
export async function detectCommands(root: string): Promise<CommandSpec[]> {
  const pkg = await readFile(join(root, 'package.json'), 'utf8').then((t) => JSON.parse(t) as { scripts?: Record<string, string> }).catch(() => null);
  const out: CommandSpec[] = [];
  if (pkg?.scripts?.test) {
    out.push({ name: 'test', argv: ['npm', 'test', '--silent'], description: `Executa os testes (npm test: ${pkg.scripts.test})` });
  }
  return out;
}
