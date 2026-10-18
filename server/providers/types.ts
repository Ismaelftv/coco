import type { ChatMessage, FinishReason, ModelInfo, ToolCall, ToolSpec, Usage } from '../../shared/contract.ts';

/** Pedido normalizado, independente do fornecedor. */
export interface ProviderRequest {
  /** Id público do modelo (o do catálogo da Forja, não o do servidor de modelos). */
  model: string;
  /** Instruções de sistema compostas pela Forja (ver server/prompts/system.ts). */
  system?: string;
  messages: ChatMessage[];
  /** Limite de tokens gerados; o registo aplica o máximo configurado para o modelo. */
  maxOutputTokens?: number;
  temperature?: number;
  /** Ferramentas oferecidas ao modelo (só em modelos com chamada nativa). */
  tools?: ToolSpec[];
}

export type ProviderEvent =
  | { type: 'delta'; text: string }
  /** Raciocínio interno do modelo ("thinking"): não é mostrado como resposta. */
  | { type: 'reasoning'; text: string }
  /** O modelo pediu a execução de uma ferramenta (chamada nativa). */
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'end'; finishReason: FinishReason; usage: Usage }
  | { type: 'error'; code: string; message: string; retryable: boolean };

/** Limites que o orquestrador precisa de conhecer para montar o contexto. */
export interface ModelLimits {
  contextTokens: number;
  maxOutputTokens: number;
  /** Como o modelo pede ferramentas: protocolo nativo do servidor ou protocolo textual da Forja. */
  toolCalling: 'native' | 'prompted';
}

/**
 * Fronteira entre o orquestrador e qualquer fornecedor de modelos
 * (servidor próprio compatível com OpenAI, API comercial opcional, simulador).
 * Ver ADR-0003 e ADR-0012.
 */
export interface ModelProvider {
  /** Lista atual (o estado pode mudar com as verificações de saúde). */
  readonly models: readonly ModelInfo[];
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  /** Limites do modelo; `undefined` se o modelo não existir. */
  limits?(model: string): ModelLimits | undefined;
  /** Volta a verificar a disponibilidade dos modelos (se aplicável). */
  refresh?(): Promise<void>;
}

/**
 * Um "backend" serve um ou mais modelos através de um protocolo.
 * O registo (registry.ts) agrega vários backends numa única ModelProvider.
 */
export interface BackendRequest extends ProviderRequest {
  /** Nome do modelo no servidor de modelos (ex.: "qwen3:4b"). */
  upstreamModel: string;
  /** Janela de contexto configurada (enviada ao servidor quando o protocolo o permite). */
  contextTokens: number;
  /** Pedir raciocínio explícito ("thinking") a modelos que o suportam. */
  think: boolean;
}

export interface ModelBackend {
  readonly id: string;
  stream(request: BackendRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  /** Modelos disponíveis no servidor, ou null se inacessível. */
  listUpstreamModels(signal: AbortSignal): Promise<string[] | null>;
}
