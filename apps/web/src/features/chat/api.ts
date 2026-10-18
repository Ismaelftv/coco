/**
 * Streaming de respostas. Usa fetch + ReadableStream em vez de EventSource
 * porque o pedido é POST com corpo JSON e precisa de cancelamento via AbortSignal.
 */
import type { FinishReason, StreamEvent, Usage } from '../../../../../shared/contract.ts';
import { apiFetch, errorFrom } from '../../lib/api.ts';
import { createSseParser } from '../../../../../shared/sse.ts';

export interface StreamHandlers {
  onStart?(data: { id: string; model: string }): void;
  onDelta(text: string): void;
  onEnd(data: { finishReason: FinishReason; usage: Usage }): void;
  onError(error: { code: string; message: string; retryable: boolean }): void;
}

export type SendBody =
  | { mode: 'send'; model: string; userMessage: { id: string; content: string; fileIds: string[] }; assistantMessageId: string }
  | { mode: 'regenerate'; model: string; fromMessageId: string; assistantMessageId: string };

/**
 * Envia o pedido e despacha os eventos. Resolve quando o stream termina.
 * Um AbortError é relançado para o chamador distinguir "Parar" de uma falha.
 */
export async function streamChat(
  conversationId: string,
  request: SendBody,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await apiFetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok) {
    const err = await errorFrom(res);
    handlers.onError({
      code: err.code,
      message: err.message,
      retryable: err.status === 429 || err.status >= 500,
    });
    return;
  }
  if (!res.body) {
    handlers.onError({ code: 'no_body', message: 'Resposta vazia do servidor.', retryable: true });
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = createSseParser();
  let ended = false;

  const dispatch = (raw: { event: string; data: string }) => {
    let data: unknown;
    try {
      data = JSON.parse(raw.data);
    } catch {
      return; // evento malformado: ignorado
    }
    const event = { type: raw.event, data } as StreamEvent;
    switch (event.type) {
      case 'message.start':
        handlers.onStart?.(event.data);
        break;
      case 'delta':
        handlers.onDelta(event.data.text);
        break;
      case 'message.end':
        ended = true;
        handlers.onEnd(event.data);
        break;
      case 'error':
        ended = true;
        handlers.onError(event.data);
        break;
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const ev of parser.feed(value)) dispatch(ev);
  }
  for (const ev of parser.flush()) dispatch(ev);

  if (!ended) {
    handlers.onError({
      code: 'stream_interrupted',
      message: 'A ligação terminou antes do fim da resposta.',
      retryable: true,
    });
  }
}
