/**
 * Contrato HTTP entre o frontend e a API. Fonte única de verdade para
 * limites, formatos de pedido e eventos de streaming.
 *
 * O servidor valida com os esquemas zod; o frontend importa daqui apenas
 * tipos (`import type`) e os limites de `limits.ts`, para não incluir zod no bundle.
 */
import { z } from 'zod';
import { LIMITS } from './limits.ts';

export { LIMITS };

export const roleSchema = z.enum(['user', 'assistant']);

export const attachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(127),
  content: z.string().max(LIMITS.attachmentBytes),
});

export const chatMessageSchema = z.object({
  role: roleSchema,
  content: z.string().max(LIMITS.messageChars * 4),
  attachments: z.array(attachmentSchema).max(LIMITS.attachmentsPerMessage).optional(),
});

export const chatRequestSchema = z.object({
  conversationId: z.string().min(1).max(64),
  model: z.string().min(1).max(64),
  messages: z
    .array(chatMessageSchema)
    .min(1)
    .max(LIMITS.historyMessages)
    .refine((m) => m[m.length - 1]?.role === 'user', {
      message: 'A última mensagem tem de ser do utilizador.',
    })
    .refine((m) => (m[m.length - 1]?.content.length ?? 0) <= LIMITS.messageChars, {
      message: `A mensagem excede ${LIMITS.messageChars} caracteres.`,
    }),
});

export type Role = z.infer<typeof roleSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export type FinishReason = 'stop' | 'length' | 'cancelled';

export interface Usage {
  /** Estimativa: o fornecedor simulado não tem tokenizador real. */
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

/** Eventos SSE emitidos por POST /api/chat. */
export type StreamEvent =
  | { type: 'message.start'; data: { id: string; model: string } }
  | { type: 'delta'; data: { text: string } }
  | { type: 'message.end'; data: { finishReason: FinishReason; usage: Usage } }
  | { type: 'error'; data: { code: string; message: string; retryable: boolean } };

export type ModelStatus = 'available' | 'simulated' | 'requires-integration';

export interface ModelInfo {
  id: string;
  label: string;
  description: string;
  status: ModelStatus;
}

export interface ApiError {
  error: { code: string; message: string };
}
