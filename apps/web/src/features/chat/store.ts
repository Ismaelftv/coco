/**
 * Estado da conversação como reducer puro (testável sem DOM).
 * Os efeitos (rede) vivem em useChat.ts. O servidor é a fonte de verdade;
 * este estado é uma cache otimista do que o utilizador vê.
 */
import type { FileInfo, FinishReason, Usage } from '../../../../../shared/contract.ts';
import { deriveTitle } from '../../../../../shared/text.ts';
import type { Conversation, Generation, Message, MessageError } from './types.ts';

export { deriveTitle };

export interface ChatState {
  conversations: Record<string, Conversation>;
  activeId: string | null;
  generation: Generation | null;
}

export const initialChatState: ChatState = { conversations: {}, activeId: null, generation: null };

export type ChatAction =
  | { type: 'hydrate'; conversations: Conversation[]; append?: boolean }
  | { type: 'loaded'; conversation: Conversation }
  | { type: 'select'; id: string | null }
  | { type: 'create'; id: string; model: string; now: number }
  | { type: 'restore'; conversation: Conversation }
  | { type: 'rename'; id: string; title: string }
  | { type: 'delete'; id: string }
  | { type: 'setModel'; id: string; model: string }
  | {
      type: 'sendUser';
      conversationId: string;
      message: { id: string; content: string; files: FileInfo[] };
      assistantId: string;
      model: string;
      now: number;
    }
  | { type: 'appendDelta'; conversationId: string; messageId: string; text: string }
  | { type: 'finish'; conversationId: string; messageId: string; finishReason: FinishReason; usage?: Usage; now: number }
  | { type: 'fail'; conversationId: string; messageId: string; error: MessageError; now: number; notPersisted?: boolean }
  | { type: 'truncateFrom'; conversationId: string; messageId: string; assistantId: string; model: string; now: number };

function updateConversation(state: ChatState, id: string, fn: (c: Conversation) => Conversation): ChatState {
  const current = state.conversations[id];
  if (!current) return state;
  return { ...state, conversations: { ...state.conversations, [id]: fn(current) } };
}

function updateMessage(c: Conversation, messageId: string, fn: (m: Message) => Message): Conversation {
  let changed = false;
  const messages = c.messages.map((m) => {
    if (m.id !== messageId) return m;
    changed = true;
    return fn(m);
  });
  return changed ? { ...c, messages } : c;
}

function emptyAssistant(id: string, model: string, now: number): Message {
  return { id, role: 'assistant', content: '', createdAt: now, status: 'streaming', model, files: [] };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'hydrate': {
      // Mantém as mensagens já carregadas e a conversa em geração.
      const conversations: Record<string, Conversation> = action.append ? { ...state.conversations } : {};
      if (!action.append) {
        for (const c of Object.values(state.conversations)) {
          if (c.id === state.activeId || c.id === state.generation?.conversationId) conversations[c.id] = c;
        }
      }
      for (const c of action.conversations) {
        const existing = state.conversations[c.id];
        conversations[c.id] = existing?.loaded ? { ...existing, title: c.title } : c;
      }
      return { ...state, conversations };
    }
    case 'loaded': {
      // Não substitui uma conversa com geração em curso.
      if (state.generation?.conversationId === action.conversation.id) return state;
      return { ...state, conversations: { ...state.conversations, [action.conversation.id]: action.conversation } };
    }
    case 'select':
      return { ...state, activeId: action.id };
    case 'create': {
      const conversation: Conversation = {
        id: action.id,
        title: 'Nova conversa',
        createdAt: action.now,
        updatedAt: action.now,
        model: action.model,
        messages: [],
        loaded: true,
      };
      return { ...state, activeId: action.id, conversations: { ...state.conversations, [action.id]: conversation } };
    }
    case 'restore':
      return { ...state, conversations: { ...state.conversations, [action.conversation.id]: action.conversation } };
    case 'rename': {
      const title = action.title.trim().slice(0, 120);
      if (!title) return state;
      return updateConversation(state, action.id, (c) => ({ ...c, title }));
    }
    case 'delete': {
      if (!state.conversations[action.id]) return state;
      const { [action.id]: _removed, ...rest } = state.conversations;
      return {
        ...state,
        conversations: rest,
        activeId: state.activeId === action.id ? null : state.activeId,
        generation: state.generation?.conversationId === action.id ? null : state.generation,
      };
    }
    case 'setModel':
      return updateConversation(state, action.id, (c) => ({ ...c, model: action.model }));
    case 'sendUser': {
      if (state.generation) return state;
      const next = updateConversation(state, action.conversationId, (c) => {
        const user: Message = {
          id: action.message.id,
          role: 'user',
          content: action.message.content,
          createdAt: action.now,
          status: 'complete',
          files: action.message.files,
        };
        const isFirst = c.messages.length === 0 && c.title === 'Nova conversa';
        return {
          ...c,
          title: isFirst ? deriveTitle(action.message.content || action.message.files[0]?.name || '') : c.title,
          updatedAt: action.now,
          model: action.model,
          messages: [...c.messages, user, emptyAssistant(action.assistantId, action.model, action.now)],
        };
      });
      if (next === state) return state;
      return { ...next, generation: { conversationId: action.conversationId, messageId: action.assistantId } };
    }
    case 'appendDelta':
      return updateConversation(state, action.conversationId, (c) =>
        updateMessage(c, action.messageId, (m) => (m.status === 'streaming' ? { ...m, content: m.content + action.text } : m)),
      );
    case 'finish': {
      const next = updateConversation(state, action.conversationId, (c) => ({
        ...updateMessage(c, action.messageId, (m) => ({
          ...m,
          status: action.finishReason === 'cancelled' ? 'cancelled' : 'complete',
          ...(action.usage ? { usage: action.usage } : {}),
        })),
        updatedAt: action.now,
      }));
      return clearGeneration(next, action.messageId);
    }
    case 'fail': {
      const next = updateConversation(state, action.conversationId, (c) => ({
        ...updateMessage(c, action.messageId, (m) => ({
          ...m,
          status: 'error',
          error: action.error,
          ...(action.notPersisted ? { notPersisted: true } : {}),
        })),
        updatedAt: action.now,
      }));
      return clearGeneration(next, action.messageId);
    }
    case 'truncateFrom': {
      if (state.generation) return state;
      const next = updateConversation(state, action.conversationId, (c) => {
        const index = c.messages.findIndex((m) => m.id === action.messageId);
        if (index === -1 || c.messages[index]?.role !== 'assistant') return c;
        return {
          ...c,
          updatedAt: action.now,
          model: action.model,
          messages: [...c.messages.slice(0, index), emptyAssistant(action.assistantId, action.model, action.now)],
        };
      });
      if (next === state) return state;
      return { ...next, generation: { conversationId: action.conversationId, messageId: action.assistantId } };
    }
  }
}

function clearGeneration(state: ChatState, messageId: string): ChatState {
  return state.generation?.messageId === messageId ? { ...state, generation: null } : state;
}

/** Conversas ordenadas da mais recente para a mais antiga. */
export function sortedConversations(state: ChatState): Conversation[] {
  return Object.values(state.conversations).sort((a, b) => b.updatedAt - a.updatedAt);
}
