/**
 * Utilitários HTTP sem dependências: erros tipados, respostas JSON,
 * leitura de corpos com limite, cookies e um router mínimo.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ZodType, ZodTypeDef } from 'zod';
import type { ApiError } from '../../shared/contract.ts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

export function sendError(res: ServerResponse, err: HttpError): void {
  const body: ApiError = { error: { code: err.code, message: err.message } };
  sendJson(res, err.status, body, err.headers);
}

export function readRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    return Promise.reject(new HttpError(413, 'payload_too_large', 'Pedido demasiado grande.'));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        req.removeAllListeners('data');
        req.resume();
        reject(new HttpError(413, 'payload_too_large', 'Pedido demasiado grande.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson<T>(req: IncomingMessage, schema: ZodType<T, ZodTypeDef, unknown>, maxBytes: number): Promise<T> {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Envia JSON.');
  const raw = await readRaw(req, maxBytes);
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'JSON inválido.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HttpError(422, 'invalid_request', first?.message ?? 'Pedido inválido.');
  }
  return parsed.data;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure: boolean;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.secure) parts.push('Secure');
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  return parts.join('; ');
}

/** Valor seguro para Content-Disposition, com nome UTF-8 (RFC 6266/5987). */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---------- Router ----------

export interface RouteContext<U = unknown> {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  url: URL;
  ip: string;
  user: U;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface Route<U> {
  method: Method;
  regex: RegExp;
  keys: string[];
  auth: boolean;
  handler(ctx: RouteContext<U>): Promise<void> | void;
}

export class Router<U> {
  private routes: Route<U>[] = [];

  add(method: Method, path: string, handler: Route<U>['handler'], opts: { auth: boolean }) {
    const keys: string[] = [];
    const pattern = path.replace(/:(\w+)/g, (_, k: string) => {
      keys.push(k);
      return '([^/]+)';
    });
    this.routes.push({ method, regex: new RegExp(`^${pattern}$`), keys, auth: opts.auth, handler });
  }

  match(method: string, pathname: string): { route: Route<U>; params: Record<string, string> } | 'method-not-allowed' | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? '');
      });
      return { route, params };
    }
    return pathMatched ? 'method-not-allowed' : null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Valida um identificador vindo do URL; um id malformado é tratado como inexistente. */
export function uuidParam(value: string | undefined): string {
  if (!value || !UUID_RE.test(value)) throw new HttpError(404, 'not_found', 'Não encontrado.');
  return value.toLowerCase();
}
