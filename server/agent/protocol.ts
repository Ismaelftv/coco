/**
 * Adaptadores de protocolo de ferramentas.
 *
 * Nem todos os modelos (nem todos os servidores) suportam chamadas de
 * ferramentas nativas. Há dois modos, escolhidos por modelo no catálogo
 * (`toolCalling`):
 *
 *  - native:   as ferramentas vão no pedido (`tools`) e o servidor devolve
 *              chamadas estruturadas (Ollama `message.tool_calls`, OpenAI
 *              `delta.tool_calls`; o vLLM precisa de --enable-auto-tool-choice).
 *  - prompted: as ferramentas são descritas no prompt de sistema e o modelo
 *              responde com um bloco JSON; o parser é tolerante às variações
 *              mais comuns (blocos ```json, <tool_call>…</tool_call>, chaves
 *              em português).
 *
 * Em ambos os modos o texto também é analisado: modelos pequenos em modo
 * nativo por vezes escrevem a chamada em texto quando o parser do servidor falha.
 * O resto do ciclo (validação, permissões, execução) é igual nos dois modos.
 */
import type { ChatMessage, ToolCall, ToolSpec } from '../../shared/contract.ts';

export type ToolCallingMode = 'native' | 'prompted';

export interface ParsedTurn {
  calls: ToolCall[];
  /** Texto do modelo sem os blocos de chamada. */
  text: string;
  /** Havia uma tentativa de chamada que não foi possível interpretar. */
  parseError?: string;
}

export interface ProtocolAdapter {
  readonly mode: ToolCallingMode;
  /** Instruções a acrescentar ao prompt de sistema. */
  systemAddendum(tools: ToolSpec[]): string;
  /** Ferramentas a enviar no pedido (só no modo nativo). */
  requestTools(tools: ToolSpec[]): ToolSpec[] | undefined;
  parseTurn(text: string, nativeCalls: ToolCall[]): ParsedTurn;
  assistantMessage(text: string, calls: ToolCall[]): ChatMessage;
  resultMessage(call: ToolCall, content: string): ChatMessage;
}

/** Extrai objetos JSON de topo de um texto (com chavetas equilibradas, respeitando strings). */
export function extractJsonObjects(text: string): { value: unknown; start: number; end: number; raw: string }[] {
  const out: { value: unknown; start: number; end: number; raw: string }[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const c = text[j]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end === -1) {
      out.push({ value: undefined, start, end: text.length, raw: text.slice(start) });
      break;
    }
    const raw = text.slice(start, end);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    out.push({ value, start, end, raw });
    i = end;
  }
  return out;
}

const NAME_KEYS = ['tool', 'name', 'ferramenta', 'tool_name', 'function'];
const ARG_KEYS = ['args', 'arguments', 'argumentos', 'parameters', 'input'];

/** Converte um objeto JSON numa chamada, aceitando as variações de chaves mais comuns. */
export function toCall(value: unknown, id: string): ToolCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  let name: unknown;
  for (const k of NAME_KEYS) {
    if (typeof obj[k] === 'string') {
      name = obj[k];
      break;
    }
    // {"function": {"name": ..., "arguments": ...}}
    if (k === 'function' && obj[k] && typeof obj[k] === 'object') return toCall(obj[k], id);
  }
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/i.test(name)) return null;
  let args: unknown = {};
  for (const k of ARG_KEYS) {
    if (k in obj) {
      args = obj[k];
      break;
    }
  }
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      /* fica a string: a validação do esquema reporta o erro */
    }
  }
  return { id, name, arguments: args ?? {} };
}

const LOOKS_LIKE_CALL = /"(tool|ferramenta|tool_name)"\s*:|<tool_call>/;

/** Analisa chamadas escritas em texto (modo textual, ou nativo com parser do servidor a falhar). */
export function parseTextCalls(text: string, idPrefix = 'txt'): ParsedTurn {
  const calls: ToolCall[] = [];
  let remaining = text;
  const spans: [number, number][] = [];
  for (const obj of extractJsonObjects(text)) {
    if (obj.value === undefined) continue;
    const call = toCall(obj.value, `${idPrefix}_${calls.length}`);
    if (call) {
      calls.push(call);
      spans.push([obj.start, obj.end]);
    }
  }
  if (spans.length) {
    let rebuilt = '';
    let last = 0;
    for (const [s, e] of spans) {
      rebuilt += text.slice(last, s);
      last = e;
    }
    remaining = rebuilt + text.slice(last);
  }
  remaining = remaining
    .replace(/<\/?tool_call>/g, '')
    .replace(/```(?:json)?\s*```/g, '')
    .trim();
  if (calls.length === 0 && LOOKS_LIKE_CALL.test(text)) {
    return { calls, text: remaining, parseError: 'A chamada de ferramenta não é JSON válido. Usa exatamente: {"tool": "nome", "args": {...}}' };
  }
  return { calls, text: remaining };
}

function describeTools(tools: ToolSpec[]): string {
  return tools.map((t) => `- ${t.name}: ${t.description}\n  argumentos (JSON Schema): ${JSON.stringify(t.parameters)}`).join('\n');
}

export const nativeAdapter: ProtocolAdapter = {
  mode: 'native',
  systemAddendum: () =>
    'Usa as ferramentas disponibilizadas através de chamadas de função. Pede UMA ferramenta de cada vez e espera pelo resultado.',
  requestTools: (tools) => tools,
  parseTurn(text, nativeCalls) {
    if (nativeCalls.length) return { calls: nativeCalls, text: text.trim() };
    return parseTextCalls(text, 'nat');
  },
  assistantMessage: (text, calls) => ({ role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}) }),
  resultMessage: (call, content) => ({ role: 'tool', content, toolCallId: call.id, toolName: call.name }),
};

export const promptedAdapter: ProtocolAdapter = {
  mode: 'prompted',
  systemAddendum: (tools) =>
    [
      'FERRAMENTAS',
      'Tens acesso às ferramentas abaixo. Para usar uma, responde com UM bloco JSON e nada mais depois dele:',
      '```json',
      '{"tool": "nome_da_ferramenta", "args": {"argumento": "valor"}}',
      '```',
      'Usa UMA ferramenta por resposta e espera pelo resultado, que chega na mensagem seguinte entre <resultado_ferramenta>.',
      'Quando a tarefa estiver feita e validada, usa a ferramenta "finish".',
      '',
      describeTools(tools),
    ].join('\n'),
  requestTools: () => undefined,
  parseTurn: (text) => parseTextCalls(text, 'txt'),
  assistantMessage: (text) => ({ role: 'assistant', content: text }),
  resultMessage: (call, content) => ({ role: 'user', content: `Resultado da ferramenta ${call.name}:\n${content}` }),
};

export function adapterFor(mode: ToolCallingMode): ProtocolAdapter {
  return mode === 'native' ? nativeAdapter : promptedAdapter;
}
