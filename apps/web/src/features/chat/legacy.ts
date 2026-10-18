/**
 * Histórico guardado no navegador pela Fase 2 (localStorage). Lido apenas para
 * oferecer a importação para a conta; depois de importado ou descartado, é apagado.
 */
export const LEGACY_KEY = 'forja.conversations.v1';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface LegacyMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  status: 'complete' | 'streaming' | 'error' | 'cancelled';
  model?: string;
  attachments?: { name: string; mediaType: string; content: string }[];
}

export interface LegacyConversation {
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: LegacyMessage[];
}

const STATUSES = new Set(['complete', 'streaming', 'error', 'cancelled']);

function toMessage(value: unknown): LegacyMessage | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
  if (typeof m.createdAt !== 'number' || !STATUSES.has(m.status as string)) return null;
  const attachments = Array.isArray(m.attachments)
    ? m.attachments
        .filter((a): a is { name: string; mediaType: string; content: string } =>
          !!a && typeof a === 'object' && typeof (a as Record<string, unknown>).name === 'string' &&
          typeof (a as Record<string, unknown>).content === 'string',
        )
        .map((a) => ({ name: a.name.slice(0, 255), mediaType: String(a.mediaType ?? 'text/plain').slice(0, 127), content: a.content }))
        .slice(0, 5)
    : undefined;
  return {
    role: m.role,
    content: m.content,
    createdAt: Math.max(0, Math.floor(m.createdAt)),
    status: m.status as LegacyMessage['status'],
    ...(typeof m.model === 'string' ? { model: m.model.slice(0, 64) } : {}),
    ...(attachments?.length ? { attachments } : {}),
  };
}

export function readLegacy(storage: KeyValueStorage | null): LegacyConversation[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: LegacyConversation[] = [];
    for (const v of parsed) {
      if (!v || typeof v !== 'object') continue;
      const c = v as Record<string, unknown>;
      if (typeof c.title !== 'string' || typeof c.createdAt !== 'number' || typeof c.updatedAt !== 'number' || !Array.isArray(c.messages)) {
        continue;
      }
      out.push({
        title: c.title.trim().slice(0, 120) || 'Conversa importada',
        model: typeof c.model === 'string' && c.model ? c.model.slice(0, 64) : 'forja-sim',
        createdAt: Math.max(0, Math.floor(c.createdAt)),
        updatedAt: Math.max(0, Math.floor(c.updatedAt)),
        messages: c.messages.map(toMessage).filter((m): m is LegacyMessage => m !== null),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function clearLegacy(storage: KeyValueStorage | null): void {
  try {
    storage?.removeItem(LEGACY_KEY);
  } catch {
    /* sem acesso ao armazenamento */
  }
}

export function browserStorage(): KeyValueStorage | null {
  try {
    const s = window.localStorage;
    s.getItem(LEGACY_KEY);
    return s;
  } catch {
    return null;
  }
}
