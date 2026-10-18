import type {
  ConversationDetail,
  ConversationSummary,
  FileInfo,
  MessageDTO,
  MessageErrorInfo,
  MessageStatus,
  Usage,
} from '../../../../../shared/contract.ts';

export type { MessageStatus };
export type MessageError = MessageErrorInfo;

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  status: MessageStatus;
  files: FileInfo[];
  model?: string | null;
  usage?: Usage | null;
  error?: MessageError | null;
  /** A falha ocorreu antes de o servidor gravar o pedido: repetir significa reenviar. */
  notPersisted?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  messages: Message[];
  /** As mensagens já foram carregadas do servidor (ou a conversa é nova). */
  loaded: boolean;
}

export interface Generation {
  conversationId: string;
  messageId: string;
}

export const fromSummary = (s: ConversationSummary): Conversation => ({
  id: s.id,
  title: s.title,
  model: s.model,
  createdAt: Date.parse(s.createdAt),
  updatedAt: Date.parse(s.updatedAt),
  messages: [],
  loaded: false,
});

export const fromMessageDTO = (m: MessageDTO): Message => ({
  id: m.id,
  role: m.role,
  content: m.content,
  createdAt: Date.parse(m.createdAt),
  status: m.status,
  files: m.files,
  model: m.model,
  usage: m.usage,
  error: m.error,
});

export const fromDetail = (d: ConversationDetail): Conversation => ({
  ...fromSummary(d),
  messages: d.messages.map(fromMessageDTO),
  loaded: true,
});
