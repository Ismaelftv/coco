import type { ChatMessage, ModelInfo } from '../../shared/contract.ts';
import { estimateTokens } from '../context.ts';
import type { ModelProvider, ProviderEvent, ProviderRequest } from './types.ts';

/**
 * Fornecedor SIMULADO. Não contém nenhum modelo de linguagem: produz texto
 * determinístico a partir de modelos de resposta, para exercitar o streaming,
 * a renderização e os estados de erro do frontend.
 *
 * Comandos de teste reconhecidos na mensagem do utilizador:
 *   #erro  → falha a meio da resposta (erro recuperável)
 *   #lento → transmite devagar (útil para testar "Parar")
 */
export interface MockProviderOptions {
  /** Atraso entre fragmentos, em ms. */
  delayMs?: number;
}

const MODELS: readonly ModelInfo[] = [
  {
    id: 'forja-sim',
    label: 'Forja Simulador',
    description: 'Respostas determinísticas para desenvolvimento. Não é um modelo de IA.',
    status: 'simulated',
  },
  {
    id: 'anthropic',
    label: 'Claude (API Anthropic)',
    description: 'Requer integração no backend (Fase 4).',
    status: 'requires-integration',
  },
  {
    id: 'openai-compatible',
    label: 'Modelo auto-alojado',
    description: 'vLLM, SGLang, llama.cpp ou Ollama via API compatível (Fase 8).',
    status: 'requires-integration',
  },
];

export function createMockProvider(options: MockProviderOptions = {}): ModelProvider {
  const baseDelay = options.delayMs ?? 14;

  return {
    models: MODELS,
    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      const last = request.messages[request.messages.length - 1];
      const prompt = last?.content ?? '';
      const text = composeReply(last, request.messages.length);
      const chunks = chunk(text);
      const failAt = prompt.includes('#erro') ? Math.floor(chunks.length / 3) : -1;
      const delay = prompt.includes('#lento') ? Math.max(baseDelay, 120) : baseDelay;

      let emitted = '';
      for (let i = 0; i < chunks.length; i++) {
        if (signal.aborted) {
          yield {
            type: 'end',
            finishReason: 'cancelled',
            usage: usage(request.messages, emitted),
          };
          return;
        }
        if (i === failAt) {
          yield {
            type: 'error',
            code: 'provider_unavailable',
            message: 'O fornecedor simulado falhou de propósito (#erro).',
            retryable: true,
          };
          return;
        }
        const piece = chunks[i] ?? '';
        emitted += piece;
        yield { type: 'delta', text: piece };
        if (delay > 0) await sleep(delay, signal);
      }
      yield { type: 'end', finishReason: 'stop', usage: usage(request.messages, emitted) };
    },
  };
}

function usage(messages: ChatMessage[], output: string) {
  const input = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  return { inputTokens: input, outputTokens: estimateTokens(output), estimated: true };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Divide em fragmentos de 1–3 palavras, preservando espaços e quebras de linha. */
export function chunk(text: string): string[] {
  const tokens = text.match(/\s+|[^\s]+/g) ?? [];
  const out: string[] = [];
  let buf = '';
  let words = 0;
  for (const t of tokens) {
    buf += t;
    if (!/^\s+$/.test(t)) words++;
    if (words >= 2 || t.includes('\n')) {
      out.push(buf);
      buf = '';
      words = 0;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
}

function composeReply(last: ChatMessage | undefined, turnCount: number): string {
  const prompt = (last?.content ?? '').trim();
  const lower = prompt.toLowerCase();
  const quoted = prompt.length > 140 ? `${prompt.slice(0, 140)}…` : prompt;
  const parts: string[] = [];

  parts.push('> **Resposta simulada.** Nenhum modelo de IA está ligado; este texto foi gerado por um modelo de resposta fixo para testar a interface.\n');

  if (quoted) {
    parts.push(`Recebi a tua mensagem (${prompt.length} caracteres, turno ${Math.ceil(turnCount / 2)}):\n\n> ${quoted.replace(/\n/g, ' ')}\n`);
  }

  const attachments = last?.attachments ?? [];
  if (attachments.length > 0) {
    parts.push('**Anexos recebidos pelo servidor:**\n');
    for (const a of attachments) {
      parts.push(`- \`${a.name}\` — ${a.mediaType}, ${formatBytes(new TextEncoder().encode(a.content).length)}`);
    }
    parts.push('');
  }

  if (/c[óo]digo|code|fun[çc][ãa]o|typescript|python|script/.test(lower)) {
    parts.push(
      '## Exemplo de bloco de código',
      '',
      'O bloco abaixo testa o realce de sintaxe e o botão de copiar:',
      '',
      '```typescript',
      'interface Tarefa {',
      '  id: string;',
      "  estado: 'pendente' | 'concluida';",
      '}',
      '',
      'export function concluir(tarefas: Tarefa[], id: string): Tarefa[] {',
      "  return tarefas.map((t) => (t.id === id ? { ...t, estado: 'concluida' } : t));",
      '}',
      '```',
      '',
    );
  } else if (/tabela|compar|table/.test(lower)) {
    parts.push(
      '## Exemplo de tabela',
      '',
      '| Transporte | Direção | Uso na Forja |',
      '|---|---|---|',
      '| SSE | Servidor → cliente | Streaming de respostas |',
      '| WebSocket | Bidirecional | Colaboração (futuro) |',
      '| HTTP | Pedido/resposta | Restante API |',
      '',
    );
  } else {
    parts.push(
      'Quando um modelo real estiver ligado, esta área mostrará a resposta dele. Até lá, podes testar:',
      '',
      '1. Pedir **código** para ver o realce de sintaxe.',
      '2. Pedir uma **tabela** para ver a renderização de tabelas.',
      '3. Escrever `#lento` e usar o botão *Parar*.',
      '4. Escrever `#erro` para ver o tratamento de falhas e o botão *Repetir*.',
      '',
    );
  }

  parts.push('Mais informação sobre o estado do projeto em `docs/03-frontend.md`.');
  return parts.join('\n');
}
