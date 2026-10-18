/**
 * Servidor de desenvolvimento: serve o build do frontend e implementa o
 * contrato da API (docs/02-arquitetura.md §4) com um fornecedor de modelos
 * injetado. Sem autenticação nem persistência — isso é a Fase 3.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIMITS, chatRequestSchema, type ApiError, type StreamEvent } from '../shared/contract.ts';
import { trimHistory } from './context.ts';
import { createRateLimiter } from './rate-limit.ts';
import { formatSse } from './sse.ts';
import type { ModelProvider } from './providers/types.ts';

export interface AppOptions {
  provider: ModelProvider;
  staticDir: string;
  /** Orçamento de contexto em tokens estimados. */
  contextBudgetTokens?: number;
  /** Pedidos de chat por minuto por cliente. */
  chatPerMinute?: number;
  log?: (line: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; " +
    "form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function createApp(options: AppOptions): Server {
  const { provider } = options;
  const staticRoot = resolve(options.staticDir);
  const budget = options.contextBudgetTokens ?? 24_000;
  const perMinute = options.chatPerMinute ?? 30;
  const limiter = createRateLimiter(perMinute, perMinute / 60);
  const log = options.log ?? (() => {});

  return createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/api/models' && req.method === 'GET') {
        return sendJson(res, 200, { models: provider.models });
      }
      if (url.pathname === '/api/chat') {
        if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed', 'Use POST.');
        const client = req.socket.remoteAddress ?? 'unknown';
        if (!limiter.take(client)) {
          res.setHeader('Retry-After', '10');
          return sendError(res, 429, 'rate_limited', 'Demasiados pedidos. Tenta dentro de momentos.');
        }
        return await handleChat(req, res);
      }
      if (url.pathname.startsWith('/api/')) {
        return sendError(res, 404, 'not_found', 'Recurso inexistente.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendError(res, 405, 'method_not_allowed', 'Método não suportado.');
      }
      return await serveStatic(url.pathname, res);
    } catch (err) {
      log(`[erro] ${req.method} ${url.pathname}: ${(err as Error).message}`);
      if (!res.headersSent) sendError(res, 500, 'internal', 'Erro interno.');
      else res.end();
    }
  });

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const type = req.headers['content-type'] ?? '';
    if (!type.startsWith('application/json')) {
      return sendError(res, 415, 'unsupported_media_type', 'Envia JSON.');
    }
    let raw: string;
    try {
      raw = await readBody(req, LIMITS.requestBodyBytes);
    } catch {
      return sendError(res, 413, 'payload_too_large', 'Pedido demasiado grande.');
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return sendError(res, 400, 'invalid_json', 'JSON inválido.');
    }
    const parsed = chatRequestSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return sendError(res, 422, 'invalid_request', first?.message ?? 'Pedido inválido.');
    }
    const body = parsed.data;
    const model = provider.models.find((m) => m.id === body.model);
    if (!model) return sendError(res, 422, 'unknown_model', 'Modelo desconhecido.');
    if (model.status === 'requires-integration') {
      return sendError(res, 409, 'model_unavailable', `${model.label} ainda não está integrado.`);
    }

    const controller = new AbortController();
    // 'close' na resposta cobre o cancelamento pelo cliente (fetch abortado).
    res.on('close', () => controller.abort());

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: StreamEvent) => {
      if (!res.writableEnded && !res.destroyed) res.write(formatSse(event));
    };

    const id = randomUUID();
    send({ type: 'message.start', data: { id, model: model.id } });
    const messages = trimHistory(body.messages, budget);
    const started = Date.now();
    try {
      for await (const ev of provider.stream({ model: model.id, messages }, controller.signal)) {
        if (ev.type === 'delta') send({ type: 'delta', data: { text: ev.text } });
        else if (ev.type === 'end') {
          send({ type: 'message.end', data: { finishReason: ev.finishReason, usage: ev.usage } });
          log(`[chat] ${id} ${model.id} ${ev.finishReason} ${Date.now() - started}ms out≈${ev.usage.outputTokens}`);
        } else {
          send({ type: 'error', data: { code: ev.code, message: ev.message, retryable: ev.retryable } });
          log(`[chat] ${id} ${model.id} error=${ev.code}`);
        }
      }
    } catch (err) {
      log(`[chat] ${id} falha do fornecedor: ${(err as Error).message}`);
      send({
        type: 'error',
        data: { code: 'provider_error', message: 'O fornecedor falhou.', retryable: true },
      });
    }
    res.end();
  }

  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return sendError(res, 400, 'bad_path', 'Caminho inválido.');
    }
    const candidate = normalize(join(staticRoot, decoded));
    if (candidate !== staticRoot && !candidate.startsWith(staticRoot + sep)) {
      return sendError(res, 403, 'forbidden', 'Proibido.');
    }
    let file = candidate;
    const info = await stat(file).catch(() => null);
    // Rotas da SPA sem extensão recebem index.html.
    if (!info || info.isDirectory()) {
      if (extname(decoded)) return sendError(res, 404, 'not_found', 'Não encontrado.');
      file = join(staticRoot, 'index.html');
    }
    const data = await readFile(file).catch(() => null);
    if (!data) return sendError(res, 404, 'not_found', 'Build em falta. Corre `npm run build`.');
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(data);
  }
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const body: ApiError = { error: { code, message } };
  sendJson(res, status, body);
}
