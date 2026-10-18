/**
 * Cliente da API. Usa fetch + ReadableStream em vez de EventSource porque o
 * pedido é POST com corpo JSON e precisa de cancelamento via AbortSignal.
 */
import type {
  ApiError,
  ChatRequest,
  FinishReason,
  ModelInfo,
  StreamEvent,
  Usage,
} from '../../../../../shared/contract.ts';
import { createSseParser } from '../../lib/sse.ts';

export interface StreamHandlers {
  onStart?(data: { id: string; model: string }): void;
  onDelta(text: string): void;
  onEnd(data: { finishReason: FinishReason; usage: Usage }): void;
  onError(error: { code: string; message: string; retryable: boolean }): void;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<HttpError> {
  try {
    const body = (await res.json()) as ApiError;
    return new HttpError(res.status, body.error.code, body.error.message);
  } catch {
    return new HttpError(res.status, 'http_error', `Erro HTTP ${res.status}.`);
  }
}

export async function fetchModels(signal?: AbortSignal): Promise<ModelInfo[]> {
  const res = await fetch('/api/models', signal ? { signal } : {});
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { models: ModelInfo[] };
  return body.models;
}

/**
 * Envia o pedido e despacha os eventos. Resolve quando o stream termina.
 * Um AbortError é relançado para o chamador distinguir "Parar" de uma falha.
 */
export async function streamChat(
  request: ChatRequest,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok) {
    const err = await readError(res);
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
