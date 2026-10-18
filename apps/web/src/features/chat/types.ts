import type { Usage } from '../../../../../shared/contract.ts';

export type MessageStatus = 'complete' | 'streaming' | 'error' | 'cancelled';

export interface MessageAttachment {
  name: string;
  mediaType: string;
  size: number;
  /** Conteúdo de texto, necessário para reenviar o histórico. */
  content: string;
}

export interface MessageError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  status: MessageStatus;
  attachments?: MessageAttachment[];
  model?: string;
  usage?: Usage;
  error?: MessageError;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  messages: Message[];
}

export interface Generation {
  conversationId: string;
  messageId: string;
}
