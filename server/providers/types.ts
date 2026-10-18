import type { ChatMessage, FinishReason, ModelInfo, Usage } from '../../shared/contract.ts';

/** Pedido normalizado, independente do fornecedor. */
export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
}

export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'end'; finishReason: FinishReason; usage: Usage }
  | { type: 'error'; code: string; message: string; retryable: boolean };

/**
 * Fronteira entre o orquestrador e qualquer fornecedor de modelos
 * (API comercial, servidor compatível com OpenAI auto-alojado, simulador).
 * Ver ADR-0003 em docs/02-arquitetura.md.
 */
export interface ModelProvider {
  readonly models: readonly ModelInfo[];
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
