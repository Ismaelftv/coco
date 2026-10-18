/**
 * Backend para a API nativa do Ollama (/api/chat, /api/tags).
 *
 * Usa-se a API nativa em vez de /v1 porque permite, por pedido:
 * - fixar a janela de contexto (`num_ctx`) — sem isto o Ollama usa um valor
 *   por omissão pequeno e corta o início da conversa sem avisar;
 * - desligar o raciocínio explícito (`think: false`) em modelos como o Qwen3;
 * - obter a contagem real de tokens (`prompt_eval_count`, `eval_count`).
 * O streaming é NDJSON (um objeto JSON por linha).
 */
import type { FinishReason, Usage } from '../../shared/contract.ts';
import { estimateTokens } from '../context.ts';
import { classifyHttp, parseToolArguments, toApiMessages, toolsToApi } from './openai-compatible.ts';
import { createThinkFilter } from './think-filter.ts';
import type { BackendRequest, ModelBackend, ProviderEvent } from './types.ts';

export interface OllamaOptions {
  id: string;
  /** Ex.: http://127.0.0.1:11434 (sem /v1). */
  baseUrl: string;
  apiKey?: string | undefined;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Campos extra no corpo (ex.: { "keep_alive": "30m" }). */
  extraBody?: Record<string, unknown>;
  log?: (line: string) => void;
}

interface ChatLine {
  message?: { content?: string; thinking?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export function createOllamaBackend(options: OllamaOptions): ModelBackend {
  const base = options.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const headersTimeout = options.headersTimeoutMs ?? 300_000; // carregar um modelo do disco pode demorar
  const idleTimeout = options.idleTimeoutMs ?? 120_000;
  const log = options.log ?? (() => {});
  const auth: Record<string, string> = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};

  return {
    id: options.id,

    async listUpstreamModels(signal) {
      try {
        const res = await fetch(`${base}/api/tags`, { headers: auth, signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
        if (!res.ok) return null;
        const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
        return (body.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean);
      } catch {
        return null;
      }
    },

    async *stream(request: BackendRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      const messages = toApiMessages(request.system, request.messages, 'ollama');
      const estimatedInput = messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
      const timer = new AbortController();
      let timedOutFlag = false;
      let timeout = setTimeout(() => {
        timedOutFlag = true;
        timer.abort();
      }, headersTimeout);
      const armIdle = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          timedOutFlag = true;
          timer.abort();
        }, idleTimeout);
      };
      const combined = AbortSignal.any([signal, timer.signal]);
      let content = '';
      let finish: FinishReason = 'stop';
      let usage: Usage | null = null;
      const think = createThinkFilter();
      let callCount = 0;

      const cancelled = (): ProviderEvent => ({
        type: 'end',
        finishReason: 'cancelled',
        usage: { inputTokens: estimatedInput, outputTokens: estimateTokens(content), estimated: true },
      });
      const timedOut = (): ProviderEvent => ({ type: 'error', code: 'model_timeout', message: 'O servidor de modelos deixou de responder.', retryable: true });

      const send = (withThink: boolean) =>
        fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...auth },
          body: JSON.stringify({
            ...options.extraBody,
            model: request.upstreamModel,
            messages,
            stream: true,
            ...toolsToApi(request.tools),
            ...(withThink ? { think: request.think } : {}),
            options: {
              num_ctx: request.contextTokens,
              ...(request.maxOutputTokens ? { num_predict: request.maxOutputTokens } : {}),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            },
          }),
          signal: combined,
        });

      try {
        let res: Response;
        try {
          res = await send(true);
          // Modelos sem suporte de raciocínio podem recusar o campo `think`: repetir sem ele.
          if (res.status === 400) {
            const detail = await res.text().catch(() => '');
            if (/think/i.test(detail)) res = await send(false);
            else {
              log(`[modelos:${options.id}] HTTP 400: ${detail.slice(0, 300)}`);
              return yield classifyHttp(400, request.upstreamModel);
            }
          }
        } catch (e) {
          if (signal.aborted) return yield cancelled();
          if (timedOutFlag) return yield timedOut();
          log(`[modelos:${options.id}] sem ligação: ${(e as Error).message}`);
          return yield { type: 'error', code: 'model_offline', message: 'O servidor de modelos não está acessível.', retryable: true };
        }
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => '');
          log(`[modelos:${options.id}] HTTP ${res.status}: ${detail.slice(0, 300)}`);
          return yield classifyHttp(res.status, request.upstreamModel);
        }

        armIdle();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        let done = false;
        while (!done) {
          let chunk: ReadableStreamReadResult<string>;
          try {
            chunk = await reader.read();
          } catch (e) {
            if (signal.aborted) return yield cancelled();
            if (timedOutFlag) return yield timedOut();
            log(`[modelos:${options.id}] stream interrompido: ${(e as Error).message}`);
            return yield { type: 'error', code: 'model_error', message: 'A ligação ao servidor de modelos foi interrompida.', retryable: true };
          }
          if (chunk.done) break;
          armIdle();
          buffer += chunk.value;
          let nl: number;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let json: ChatLine;
            try {
              json = JSON.parse(line) as ChatLine;
            } catch {
              continue;
            }
            if (json.error) {
              log(`[modelos:${options.id}] erro no stream: ${json.error.slice(0, 300)}`);
              return yield { type: 'error', code: 'model_error', message: 'O servidor de modelos falhou durante a resposta.', retryable: true };
            }
            if (json.message?.thinking) yield { type: 'reasoning', text: json.message.thinking };
            for (const tc of json.message?.tool_calls ?? []) {
              // O Ollama envia cada chamada completa, com os argumentos já em objeto.
              yield {
                type: 'tool_call',
                call: { id: `call_${callCount++}`, name: tc.function?.name ?? '', arguments: parseToolArguments(tc.function?.arguments) },
              };
            }
            if (json.message?.content) {
              const split = think.push(json.message.content);
              if (split.reasoning) yield { type: 'reasoning', text: split.reasoning };
              if (split.content) {
                content += split.content;
                yield { type: 'delta', text: split.content };
              }
            }
            if (json.done) {
              finish = json.done_reason === 'length' ? 'length' : 'stop';
              if (typeof json.eval_count === 'number') {
                usage = { inputTokens: json.prompt_eval_count ?? estimatedInput, outputTokens: json.eval_count, estimated: false };
              }
              done = true;
              break;
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
        yield { type: 'end', finishReason: finish, usage: usage ?? { inputTokens: estimatedInput, outputTokens: estimateTokens(content), estimated: true } };
      } finally {
        clearTimeout(timeout);
        timer.abort();
      }
    },
  };
}
