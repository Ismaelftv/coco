/**
 * Backend para servidores com API compatível com OpenAI (/v1/chat/completions):
 * Ollama, vLLM, llama.cpp (llama-server), SGLang — e, opcionalmente, APIs
 * comerciais com o mesmo formato. Sem dependências: fetch + parser SSE próprio.
 *
 * Garantias:
 * - cancelar o pedido do utilizador fecha a ligação ao servidor de modelos;
 * - tempo limite até à primeira resposta e entre fragmentos;
 * - raciocínio interno separado da resposta (campos `reasoning*` e `<think>`);
 * - mensagens de erro para o utilizador são genéricas; o detalhe vai para o log.
 */
import { createSseParser } from '../../shared/sse.ts';
import type { ChatMessage, FinishReason, Usage } from '../../shared/contract.ts';
import { estimateTokens } from '../context.ts';
import { createThinkFilter } from './think-filter.ts';
import type { BackendRequest, ModelBackend, ProviderEvent } from './types.ts';

export interface OpenAICompatibleOptions {
  id: string;
  /** URL base que termina em /v1, ex.: http://127.0.0.1:11434/v1 */
  baseUrl: string;
  /** Chave já resolvida a partir do ambiente (nunca vem do ficheiro de configuração). */
  apiKey?: string | undefined;
  /** Tempo máximo até aos cabeçalhos da resposta (o primeiro pedido pode carregar o modelo). */
  headersTimeoutMs?: number;
  /** Tempo máximo sem receber dados durante o streaming. */
  idleTimeoutMs?: number;
  /** Campos extra no corpo do pedido (ex.: opções de raciocínio específicas do servidor). */
  extraBody?: Record<string, unknown>;
  log?: (line: string) => void;
}

type ApiMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * Converte o histórico normalizado para o formato OpenAI. O texto dos anexos
 * vai delimitado e marcado como conteúdo do utilizador (dados, não instruções).
 */
export function toApiMessages(system: string | undefined, messages: ChatMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    let content = m.content;
    for (const a of m.attachments ?? []) {
      const name = a.name.replace(/["<>]/g, '_');
      content +=
        a.content.length > 0
          ? `\n\n<ficheiro nome="${name}" tipo="${a.mediaType.split(';')[0]}">\n${a.content}\n</ficheiro>`
          : `\n\n[Anexo "${name}" (${a.mediaType.split(';')[0]}) não incluído: este modelo não interpreta este tipo de ficheiro.]`;
    }
    out.push({ role: m.role, content });
  }
  return out;
}

export function mapFinishReason(reason: string | null | undefined): FinishReason {
  return reason === 'length' ? 'length' : 'stop';
}

interface ChunkJson {
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string } | string;
}

export function classifyHttp(status: number, upstreamModel: string): Extract<ProviderEvent, { type: 'error' }> {
  if (status === 404) {
    return { type: 'error', code: 'model_not_found', message: `O modelo "${upstreamModel}" não está disponível no servidor de modelos.`, retryable: false };
  }
  if (status === 401 || status === 403) {
    return { type: 'error', code: 'model_auth', message: 'O servidor de modelos recusou as credenciais configuradas.', retryable: false };
  }
  if (status === 429) return { type: 'error', code: 'model_busy', message: 'O servidor de modelos está ocupado. Tenta de novo.', retryable: true };
  if (status === 400 || status === 413 || status === 422) {
    return { type: 'error', code: 'model_bad_request', message: 'O servidor de modelos recusou o pedido (pode ser demasiado longo).', retryable: false };
  }
  return { type: 'error', code: 'model_error', message: 'O servidor de modelos falhou.', retryable: true };
}

export function createOpenAICompatibleBackend(options: OpenAICompatibleOptions): ModelBackend {
  const base = options.baseUrl.replace(/\/+$/, '');
  const headersTimeout = options.headersTimeoutMs ?? 120_000;
  const idleTimeout = options.idleTimeoutMs ?? 60_000;
  const log = options.log ?? (() => {});
  const headers = (json: boolean): Record<string, string> => ({
    ...(json ? { 'Content-Type': 'application/json', Accept: 'text/event-stream' } : {}),
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
  });

  return {
    id: options.id,

    async listUpstreamModels(signal) {
      try {
        const res = await fetch(`${base}/models`, { headers: headers(false), signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
        if (!res.ok) return null;
        const body = (await res.json()) as { data?: { id?: string }[] };
        return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
      } catch {
        return null;
      }
    },

    async *stream(request: BackendRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      const messages = toApiMessages(request.system, request.messages);
      const estimatedInput = messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
      const timer = new AbortController();
      let timeoutCode: 'model_timeout' | null = null;
      let timeout = setTimeout(() => {
        timeoutCode = 'model_timeout';
        timer.abort();
      }, headersTimeout);
      const armIdle = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          timeoutCode = 'model_timeout';
          timer.abort();
        }, idleTimeout);
      };
      const combined = AbortSignal.any([signal, timer.signal]);

      let content = '';
      let finish: FinishReason = 'stop';
      let usage: Usage | null = null;
      const think = createThinkFilter();

      const cancelled = (): ProviderEvent => ({
        type: 'end',
        finishReason: 'cancelled',
        usage: { inputTokens: estimatedInput, outputTokens: estimateTokens(content), estimated: true },
      });
      const timedOut = (): ProviderEvent => ({
        type: 'error',
        code: 'model_timeout',
        message: 'O servidor de modelos deixou de responder.',
        retryable: true,
      });

      try {
        let res: Response;
        try {
          res = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: headers(true),
            body: JSON.stringify({
              ...options.extraBody,
              model: request.upstreamModel,
              messages,
              stream: true,
              stream_options: { include_usage: true },
              ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            }),
            signal: combined,
          });
        } catch (e) {
          if (signal.aborted) return yield cancelled();
          if (timeoutCode) return yield timedOut();
          log(`[modelos:${options.id}] sem ligação: ${(e as Error).message}`);
          return yield { type: 'error', code: 'model_offline', message: 'O servidor de modelos não está acessível.', retryable: true };
        }

        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => '');
          log(`[modelos:${options.id}] HTTP ${res.status}: ${detail.slice(0, 300)}`);
          return yield classifyHttp(res.status, request.upstreamModel);
        }

        armIdle();
        const parser = createSseParser();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let done = false;
        while (!done) {
          let chunk: ReadableStreamReadResult<string>;
          try {
            chunk = await reader.read();
          } catch (e) {
            if (signal.aborted) return yield cancelled();
            if (timeoutCode) return yield timedOut();
            log(`[modelos:${options.id}] stream interrompido: ${(e as Error).message}`);
            return yield { type: 'error', code: 'model_error', message: 'A ligação ao servidor de modelos foi interrompida.', retryable: true };
          }
          if (chunk.done) break;
          armIdle();
          for (const ev of parser.feed(chunk.value)) {
            if (ev.data === '[DONE]') {
              done = true;
              break;
            }
            let json: ChunkJson;
            try {
              json = JSON.parse(ev.data) as ChunkJson;
            } catch {
              continue;
            }
            if (json.error) {
              log(`[modelos:${options.id}] erro no stream: ${JSON.stringify(json.error).slice(0, 300)}`);
              return yield { type: 'error', code: 'model_error', message: 'O servidor de modelos falhou durante a resposta.', retryable: true };
            }
            const choice = json.choices?.[0];
            const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
            if (reasoning) yield { type: 'reasoning', text: reasoning };
            if (choice?.delta?.content) {
              const split = think.push(choice.delta.content);
              if (split.reasoning) yield { type: 'reasoning', text: split.reasoning };
              if (split.content) {
                content += split.content;
                yield { type: 'delta', text: split.content };
              }
            }
            if (choice?.finish_reason) finish = mapFinishReason(choice.finish_reason);
            if (json.usage && typeof json.usage.completion_tokens === 'number') {
              usage = {
                inputTokens: json.usage.prompt_tokens ?? estimatedInput,
                outputTokens: json.usage.completion_tokens,
                estimated: false,
              };
            }
          }
        }
        const rest = think.flush();
        if (rest.reasoning) yield { type: 'reasoning', text: rest.reasoning };
        if (rest.content) {
          content += rest.content;
          yield { type: 'delta', text: rest.content };
        }
        if (signal.aborted) return yield cancelled();
        yield {
          type: 'end',
          finishReason: finish,
          usage: usage ?? { inputTokens: estimatedInput, outputTokens: estimateTokens(content), estimated: true },
        };
      } finally {
        clearTimeout(timeout);
        timer.abort(); // garante que a ligação ao servidor de modelos é fechada
      }
    },
  };
}
