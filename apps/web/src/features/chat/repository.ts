/**
 * Persistência das conversas atrás de uma interface, para trocar o
 * armazenamento local pela API (Fase 3) sem tocar na UI.
 *
 * Implementação atual: localStorage do navegador. É TEMPORÁRIA — os dados
 * ficam apenas neste navegador e não são sincronizados.
 */
import type { Conversation, Message } from './types.ts';

export interface ConversationRepository {
  load(): Conversation[];
  save(conversations: Conversation[]): void;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'forja.conversations.v1';
/** Margem abaixo do limite típico de ~5 MB do localStorage. */
const MAX_BYTES = 4 * 1024 * 1024;

export function createLocalRepository(storage: KeyValueStorage | null): ConversationRepository {
  return {
    load() {
      if (!storage) return [];
      try {
        const raw = storage.getItem(KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isConversation).map(recoverInterrupted);
      } catch {
        return [];
      }
    },
    save(conversations) {
      if (!storage) return;
      const ordered = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
      // Se exceder o orçamento, descarta as conversas mais antigas.
      for (let n = ordered.length; n >= 0; n--) {
        const json = JSON.stringify(ordered.slice(0, n));
        if (json.length * 2 <= MAX_BYTES) {
          try {
            storage.setItem(KEY, json);
          } catch {
            continue; // quota excedida: tenta com menos conversas
          }
          return;
        }
      }
    },
  };
}

/** Uma geração interrompida por um recarregamento da página fica como cancelada. */
function recoverInterrupted(c: Conversation): Conversation {
  if (!c.messages.some((m) => m.status === 'streaming')) return c;
  return {
    ...c,
    messages: c.messages.map((m): Message => (m.status === 'streaming' ? { ...m, status: 'cancelled' } : m)),
  };
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.title === 'string' &&
    typeof c.createdAt === 'number' &&
    typeof c.updatedAt === 'number' &&
    typeof c.model === 'string' &&
    Array.isArray(c.messages) &&
    c.messages.every(isMessage)
  );
}

function isMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    (m.role === 'user' || m.role === 'assistant') &&
    typeof m.content === 'string' &&
    typeof m.createdAt === 'number' &&
    (m.status === 'complete' || m.status === 'streaming' || m.status === 'error' || m.status === 'cancelled')
  );
}

export function browserStorage(): KeyValueStorage | null {
  try {
    const s = window.localStorage;
    const probe = '__forja_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
