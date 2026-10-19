/**
 * Contrato HTTP entre o frontend e a API. Fonte única de verdade para
 * formatos de pedido, respostas e eventos de streaming.
 *
 * O servidor valida com os esquemas zod; o frontend importa daqui apenas
 * tipos (`import type`) e os limites de `limits.ts`, para não incluir zod no bundle.
 */
import { z } from 'zod';
import { LIMITS } from './limits.ts';

export { LIMITS };

const uuid = z.string().uuid();

// ---------- Autenticação ----------

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Email inválido.');

export const signupSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(LIMITS.passwordMin, `A palavra-passe precisa de pelo menos ${LIMITS.passwordMin} caracteres.`)
    .max(LIMITS.passwordMax),
  displayName: z.string().trim().min(1).max(80).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(LIMITS.passwordMax),
});

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

// ---------- Conversas e mensagens ----------

export const createConversationSchema = z.object({
  id: uuid,
  model: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(120).optional(),
});

export const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    model: z.string().min(1).max(64).optional(),
  })
  .refine((v) => v.title !== undefined || v.model !== undefined, { message: 'Nada para alterar.' });

export const sendMessageSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('send'),
    model: z.string().min(1).max(64),
    userMessage: z.object({
      id: uuid,
      content: z.string().max(LIMITS.messageChars, `A mensagem excede ${LIMITS.messageChars} caracteres.`),
      fileIds: z.array(uuid).max(LIMITS.attachmentsPerMessage).default([]),
    }),
    assistantMessageId: uuid,
  }),
  z.object({
    mode: z.literal('regenerate'),
    model: z.string().min(1).max(64),
    fromMessageId: uuid,
    assistantMessageId: uuid,
  }),
]);

export type MessageStatus = 'complete' | 'streaming' | 'error' | 'cancelled';
export type FinishReason = 'stop' | 'length' | 'cancelled';

export interface Usage {
  /** Estimativa enquanto não houver tokenizador do modelo. */
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

export interface MessageErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export type FileKind = 'text' | 'image' | 'pdf';

export interface FileInfo {
  id: string;
  name: string;
  mediaType: string;
  kind: FileKind;
  size: number;
  createdAt: string;
}

export interface MessageDTO {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  model: string | null;
  error: MessageErrorInfo | null;
  usage: Usage | null;
  files: FileInfo[];
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  messages: MessageDTO[];
}

// ---------- Importação do histórico guardado no navegador (Fase 2) ----------

const legacyMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(LIMITS.messageChars * 4),
  createdAt: z.number().int().nonnegative(),
  status: z.enum(['complete', 'streaming', 'error', 'cancelled']),
  model: z.string().max(64).optional(),
  attachments: z
    .array(z.object({ name: z.string().min(1).max(255), mediaType: z.string().max(127), content: z.string().max(LIMITS.textFileBytes) }))
    .max(LIMITS.attachmentsPerMessage)
    .optional(),
});

export const importSchema = z.object({
  conversations: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(120),
        model: z.string().min(1).max(64),
        createdAt: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
        messages: z.array(legacyMessage).max(1000),
      }),
    )
    .max(500),
});

// ---------- Streaming ----------

/** Eventos SSE emitidos por POST /api/conversations/:id/messages. */
export type StreamEvent =
  | { type: 'message.start'; data: { id: string; model: string } }
  | { type: 'delta'; data: { text: string } }
  | { type: 'message.end'; data: { finishReason: FinishReason; usage: Usage } }
  | { type: 'error'; data: MessageErrorInfo };

/**
 * Estado de um modelo:
 * - available: servidor de modelos acessível e modelo presente;
 * - offline: configurado, mas o servidor não responde ou o modelo não está descarregado;
 * - simulated: fornecedor simulado, sem IA.
 */
export type ModelStatus = 'available' | 'offline' | 'simulated';

/** Onde o modelo corre. `external` = API de terceiros (opcional, nunca obrigatória). */
export type ModelHosting = 'simulated' | 'self-hosted' | 'external';

/** O que o frontend pode saber sobre um modelo (nunca URLs internos nem chaves). */
export interface ModelInfo {
  id: string;
  label: string;
  description: string;
  status: ModelStatus;
  hosting: ModelHosting;
  /** Autor dos pesos/serviço, ex.: "Alibaba (Qwen)". */
  author: string | null;
  /** Licença dos pesos, ex.: "Apache-2.0". */
  license: string | null;
  /** Explicação curta quando `offline`. */
  statusDetail: string | null;
}

/** Mensagem normalizada enviada a um fornecedor de modelos. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** `content` só é preenchido para texto; imagens/PDF vão sem conteúdo até haver modelo multimodal. */
  attachments?: { name: string; mediaType: string; content: string; size?: number }[];
  /** Mensagem do assistente: ferramentas pedidas pelo modelo (chamada nativa). */
  toolCalls?: ToolCall[];
  /** Mensagem `tool`: a que chamada e ferramenta responde. */
  toolCallId?: string;
  toolName?: string;
}

/** Pedido de execução de ferramenta feito por um modelo. */
export interface ToolCall {
  id: string;
  name: string;
  /** Objeto de argumentos; texto em bruto se o modelo enviou JSON inválido. */
  arguments: unknown;
}

/** Descrição de uma ferramenta entregue ao modelo (JSON Schema nos parâmetros). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ApiError {
  error: { code: string; message: string };
}
