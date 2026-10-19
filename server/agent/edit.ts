/**
 * Edição de ficheiros segura para agentes.
 *
 * Regras:
 *  - nunca se escolhe uma ocorrência por conta própria: se oldText aparece várias vezes, a edição
 *    é RECUSADA e o agente recebe as linhas e o contexto de cada ocorrência; só uma seleção
 *    explícita (`line` ou `occurrence` + `expectedMatches`) desambigua, e é verificada;
 *  - a edição é planeada sobre o conteúdo lido e só é aplicada se o ficheiro continuar IGUAL
 *    (byte a byte) imediatamente antes de escrever (a confirmação do utilizador pode demorar);
 *  - a escrita é atómica: ficheiro temporário no mesmo diretório + rename; uma falha nunca deixa
 *    o ficheiro a meio nem lixo para trás;
 *  - depois de escrever o ficheiro é reaberto e comparado com o esperado; se não coincidir,
 *    repõe-se o original e a ferramenta falha.
 * Limite conhecido: entre a verificação final e o rename não há bloqueio do sistema de ficheiros;
 * o agente é o único escritor do espaço de trabalho durante uma tarefa.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ToolError } from './workspace.ts';

export interface FileIO {
  read(abs: string): Promise<Buffer>;
  /** Cria um ficheiro novo (falha se existir) com o conteúdo e o modo indicados. */
  writeNew(abs: string, data: Buffer, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(abs: string): Promise<void>;
}

export const nodeIO: FileIO = {
  read: (abs) => readFile(abs),
  async writeNew(abs, data, mode) {
    const fh = await open(abs, 'wx', mode);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await chmod(abs, mode);
  },
  rename: (from, to) => rename(from, to),
  remove: (abs) => rm(abs, { force: true }),
};

export interface Occurrence {
  /** Posição (UTF-16) onde começa. */
  index: number;
  /** Linha (1-based) onde começa. */
  line: number;
  /** Linha onde termina. */
  endLine: number;
}

export const versionOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** Todas as ocorrências, incluindo sobrepostas ("aa" em "aaa" são 2). */
export function findOccurrences(text: string, needle: string): Occurrence[] {
  if (!needle) return [];
  const out: Occurrence[] = [];
  const nl = (needle.match(/\n/g) ?? []).length;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const line = lineAt(text, i);
    out.push({ index: i, line, endLine: line + nl });
  }
  return out;
}

function snippet(lines: string[], occ: Occurrence, context = 2): string {
  const from = Math.max(1, occ.line - context);
  const to = Math.min(lines.length, occ.endLine + context);
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    const mark = n >= occ.line && n <= occ.endLine ? '>' : ' ';
    const l = lines[n - 1] ?? '';
    out.push(`${mark}${String(n).padStart(4)}| ${l.length > 160 ? `${l.slice(0, 160)}…` : l}`);
  }
  return out.join('\n');
}

export function describeOccurrences(text: string, occs: Occurrence[], max = 8): string {
  const lines = text.split('\n');
  const shown = occs.slice(0, max).map((o, i) => `Ocorrência ${i + 1} (linha${o.endLine > o.line ? `s ${o.line}-${o.endLine}` : ` ${o.line}`}):\n${snippet(lines, o)}`);
  const more = occs.length > max ? `\n[... mais ${occs.length - max} ocorrências ...]` : '';
  return shown.join('\n\n') + more;
}

export interface EditRequest {
  oldText: string;
  newText: string;
  /** Linha (1-based) onde começa a ocorrência pretendida. */
  line?: number | undefined;
  /** Índice (1-based) da ocorrência na lista devolvida; exige expectedMatches. */
  occurrence?: number | undefined;
  /** Quantas ocorrências o agente viu; se o ficheiro já não tem este número, é recusado. */
  expectedMatches?: number | undefined;
  /** Versão do ficheiro vista pelo agente (devolvida nos erros de ambiguidade). */
  version?: string | undefined;
}

export interface EditPlan {
  next: string;
  chosen: Occurrence;
  matches: number;
  version: string;
}

/** Remove o prefixo "  12| " que os modelos copiam da leitura. */
function stripLineNumbers(s: string): string {
  return s.replace(/^\s*\d+\| ?/gm, '');
}

export function planEdit(rel: string, text: string, req: EditRequest): EditPlan {
  const ver = versionOf(text);
  if (req.line !== undefined && req.occurrence !== undefined) throw new ToolError('Indica `line` OU `occurrence`, não ambos.', 'invalid');
  if (req.version !== undefined && req.version !== ver) {
    throw new ToolError(`O ficheiro "${rel}" mudou desde que o leste (versão ${ver}, esperada ${req.version}). Nada foi alterado. Lê o ficheiro de novo.`, 'conflict');
  }
  let oldText = req.oldText;
  let newText = req.newText;
  const tryNeedle = (n: string) => findOccurrences(text, n);
  let occs = tryNeedle(oldText);
  if (occs.length === 0 && /^\s*\d+\| /m.test(oldText)) {
    oldText = stripLineNumbers(oldText);
    newText = /^\s*\d+\| /m.test(newText) ? stripLineNumbers(newText) : newText;
    occs = tryNeedle(oldText);
  }
  if (occs.length === 0 && text.includes('\r\n') && !oldText.includes('\r\n') && oldText.includes('\n')) {
    // Ficheiro com CRLF e excerto copiado com LF: adapta ambos para não misturar fins de linha.
    const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
    const converted = crlf(oldText);
    const c = tryNeedle(converted);
    if (c.length > 0) {
      oldText = converted;
      newText = crlf(newText);
      occs = c;
    }
  }
  if (occs.length === 0) {
    const first = oldText.split('\n').map((l) => l.trim()).find((l) => l.length >= 4);
    const near: Occurrence[] = [];
    if (first) {
      const lines = text.split('\n');
      lines.forEach((l, i) => {
        if (l.includes(first) && near.length < 5) near.push({ index: 0, line: i + 1, endLine: i + 1 });
      });
    }
    const hint = near.length
      ? `\nA linha "${first!.slice(0, 80)}" existe em: ${near.map((n) => n.line).join(', ')} (verifica espaços, indentação e linhas seguintes).\n${describeOccurrences(text, near, 3)}`
      : '';
    throw new ToolError(`oldText não existe em "${rel}". Nada foi alterado. Lê o ficheiro de novo e copia o texto exato.${hint}`, 'conflict');
  }
  if (oldText === newText) throw new ToolError('newText é igual a oldText: não há alteração.', 'invalid');

  const how = `Repete edit_file com \`line\` (linha onde o excerto começa) ou com \`occurrence\` + \`expectedMatches: ${occs.length}\`; inclui \`version: "${ver}"\` para garantir que o ficheiro não mudou.`;
  let chosen: Occurrence;
  if (req.expectedMatches !== undefined && req.expectedMatches !== occs.length) {
    const lines = occs.map((o) => o.line).join(', ');
    throw new ToolError(
      `Esperavas ${req.expectedMatches} ocorrência(s) mas "${rel}" tem agora ${occs.length} (linhas ${lines}). Nada foi alterado.\n${describeOccurrences(text, occs)}\n${how}\n` +
        `\`expectedMatches\` só confirma a contagem: se usas \`line\`, podes omiti-lo; se o indicares, tem de ser ${occs.length}, não ${req.expectedMatches}.`,
      'conflict',
    );
  }
  if (req.line !== undefined) {
    const atLine = occs.filter((o) => o.line === req.line);
    if (atLine.length === 0) {
      throw new ToolError(`Nenhuma ocorrência de oldText começa na linha ${req.line} de "${rel}" (o contexto não corresponde). Nada foi alterado. Começam em: ${occs.map((o) => o.line).join(', ')}.\n${describeOccurrences(text, occs)}`, 'conflict');
    }
    if (atLine.length > 1) {
      throw new ToolError(`Mais de uma ocorrência começa na linha ${req.line}; inclui mais texto em oldText para a tornar única. Nada foi alterado.`, 'conflict');
    }
    chosen = atLine[0]!;
  } else if (req.occurrence !== undefined) {
    if (req.expectedMatches === undefined) throw new ToolError('`occurrence` exige `expectedMatches` (o número de ocorrências que viste).', 'invalid');
    if (!Number.isInteger(req.occurrence) || req.occurrence < 1 || req.occurrence > occs.length) {
      throw new ToolError(`occurrence ${req.occurrence} fora do intervalo 1-${occs.length}. Nada foi alterado.`, 'invalid');
    }
    chosen = occs[req.occurrence - 1]!;
  } else if (occs.length === 1) {
    chosen = occs[0]!;
  } else {
    throw new ToolError(`oldText aparece ${occs.length} vezes em "${rel}" e não escolho por ti. Nada foi alterado.\n${describeOccurrences(text, occs)}\n${how}`, 'conflict');
  }
  const next = text.slice(0, chosen.index) + newText + text.slice(chosen.index + oldText.length);
  return { next, chosen, matches: occs.length, version: ver };
}

/**
 * Escrita atómica com pré-condição. `before` é o conteúdo em que o plano se baseou (null = ficheiro novo).
 * Falha sem alterar nada se o ficheiro mudou, se a escrita falhar, ou se a releitura não coincidir.
 */
export async function commitAtomic(abs: string, before: Buffer | null, data: Buffer, io: FileIO = nodeIO): Promise<void> {
  const current = await io.read(abs).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  if (before === null ? current !== null : current === null || !current.equals(before)) {
    throw new ToolError(`O ficheiro mudou desde que foi lido${before === null ? ' (já existe)' : ''}. Nada foi alterado.`, 'conflict');
  }
  const mode = current ? ((await stat(abs)).mode & 0o7777) : 0o644;
  const tmp = join(dirname(abs), `.${basename(abs)}.forja-${randomBytes(4).toString('hex')}.tmp`);
  try {
    await io.writeNew(tmp, data, mode);
    await io.rename(tmp, abs);
  } catch (e) {
    await io.remove(tmp).catch(() => {});
    if (e instanceof ToolError) throw e;
    throw new ToolError(`Falha ao escrever "${basename(abs)}": ${(e as Error).message}. O ficheiro original não foi alterado.`, 'failed');
  }
  // Reabrir e validar o resultado.
  const after = await io.read(abs).catch(() => null);
  if (!after || !after.equals(data)) {
    let restored = false;
    if (current) {
      const back = join(dirname(abs), `.${basename(abs)}.forja-${randomBytes(4).toString('hex')}.tmp`);
      try {
        await io.writeNew(back, current, mode);
        await io.rename(back, abs);
        restored = true;
      } catch {
        await io.remove(back).catch(() => {});
      }
    } else {
      await io.remove(abs).catch(() => {});
      restored = true;
    }
    throw new ToolError(`A verificação após escrever falhou (conteúdo diferente do esperado); ${restored ? 'o estado anterior foi reposto' : 'NÃO foi possível repor o estado anterior'}.`, 'failed');
  }
}
