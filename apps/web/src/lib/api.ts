/**
 * Cliente HTTP da API. A sessão vive num cookie HttpOnly: o JavaScript da
 * página nunca vê o token. Um 401 em qualquer pedido avisa a aplicação para
 * voltar ao ecrã de entrada.
 */
import type {
  ApiError,
  Capabilities,
  ConversationDetail,
  ConversationSummary,
  FileInfo,
  ModelInfo,
  User,
} from '../../../../shared/contract.ts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export async function errorFrom(res: Response): Promise<HttpError> {
  try {
    const body = (await res.json()) as ApiError;
    return new HttpError(res.status, body.error.code, body.error.message);
  } catch {
    return new HttpError(res.status, 'http_error', `Erro HTTP ${res.status}.`);
  }
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.status === 401 && !path.startsWith('/api/auth/')) unauthorizedListeners.forEach((fn) => fn());
  return res;
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await apiFetch(path, { ...init, headers });
  if (!res.ok) throw await errorFrom(res);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const body = (value: unknown) => JSON.stringify(value);

export const api = {
  me: () => json<{ user: User }>('/api/auth/me'),
  authConfig: () => json<{ signupEnabled: boolean }>('/api/auth/config'),
  login: (email: string, password: string) =>
    json<{ user: User }>('/api/auth/login', { method: 'POST', body: body({ email, password }) }),
  signup: (email: string, password: string, displayName?: string) =>
    json<{ user: User }>('/api/auth/signup', {
      method: 'POST',
      body: body({ email, password, ...(displayName ? { displayName } : {}) }),
    }),
  logout: () => json<void>('/api/auth/logout', { method: 'POST' }),

  capabilities: () => json<Capabilities>('/api/capabilities'),
  createImage: (conversationId: string, payload: { prompt: string; userMessageId: string; assistantMessageId: string }, signal?: AbortSignal) =>
    json<{ fileId: string }>(`/api/conversations/${conversationId}/images`, { method: 'POST', body: body(payload), ...(signal ? { signal } : {}) }),
  models: (signal?: AbortSignal) => json<{ models: ModelInfo[] }>('/api/models', signal ? { signal } : {}),

  listConversations: (params: { q?: string; cursor?: string | null }, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.cursor) qs.set('cursor', params.cursor);
    const s = qs.toString();
    return json<{ conversations: ConversationSummary[]; nextCursor: string | null }>(
      `/api/conversations${s ? `?${s}` : ''}`,
      signal ? { signal } : {},
    );
  },
  getConversation: (id: string, signal?: AbortSignal) =>
    json<{ conversation: ConversationDetail }>(`/api/conversations/${id}`, signal ? { signal } : {}),
  createConversation: (id: string, model: string) =>
    json<{ conversation: ConversationSummary }>('/api/conversations', { method: 'POST', body: body({ id, model }) }),
  updateConversation: (id: string, patch: { title?: string; model?: string }) =>
    json<{ conversation: ConversationSummary }>(`/api/conversations/${id}`, { method: 'PATCH', body: body(patch) }),
  deleteConversation: (id: string) => json<void>(`/api/conversations/${id}`, { method: 'DELETE' }),

  deleteFile: (id: string) => json<void>(`/api/files/${id}`, { method: 'DELETE' }),
  fileUrl: (id: string) => `/api/files/${id}/content`,

  importLocal: (payload: unknown) =>
    json<{ imported: { conversations: number; messages: number; files: number } }>('/api/import/local', {
      method: 'POST',
      body: body(payload),
    }),
};

export interface UploadHandle {
  promise: Promise<FileInfo>;
  abort(): void;
}

/** Upload com progresso (fetch ainda não expõe progresso de envio de forma portável). */
export function uploadFile(file: File, onProgress: (fraction: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<FileInfo>((resolve, reject) => {
    xhr.open('POST', '/api/files');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let parsed: { file?: FileInfo; error?: { code: string; message: string } } = {};
      try {
        parsed = JSON.parse(xhr.responseText) as typeof parsed;
      } catch {
        /* resposta não JSON */
      }
      if (xhr.status === 201 && parsed.file) return resolve(parsed.file);
      if (xhr.status === 401) unauthorizedListeners.forEach((fn) => fn());
      reject(new HttpError(xhr.status, parsed.error?.code ?? 'upload_failed', parsed.error?.message ?? 'O envio falhou.'));
    };
    xhr.onerror = () => reject(new HttpError(0, 'network', 'Falha de rede durante o envio.'));
    xhr.onabort = () => reject(new HttpError(0, 'aborted', 'Envio cancelado.'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
