/**
 * Composição do servidor: cabeçalhos de segurança, verificação de origem
 * (CSRF), autenticação por sessão, rotas da API e ficheiros estáticos.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import { HttpError, Router, sendError, sendJson } from './http/http.ts';
import { createAuth, type AuthUser } from './modules/auth.ts';
import { registerChat } from './modules/chat.ts';
import { registerConversations } from './modules/conversations.ts';
import { registerFiles } from './modules/files.ts';
import { registerImport } from './modules/import.ts';
import type { ModelProvider } from './providers/types.ts';
import { createStatic } from './static.ts';
import type { ObjectStorage } from './storage/storage.ts';

export interface AppDeps {
  config: Config;
  db: Db;
  provider: ModelProvider;
  storage: ObjectStorage;
  staticDir: string;
  log?: (line: string) => void;
}

export interface App {
  server: Server;
  /** Termina gerações em curso (gravando-as) antes de fechar. */
  shutdown(): Promise<void>;
}

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
    "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; " +
    "form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createApp(deps: AppDeps): App {
  const { config, db, provider, storage } = deps;
  const log = deps.log ?? (() => {});
  const router = new Router<AuthUser | null>();
  const auth = createAuth(db, config);
  const serveStatic = createStatic(deps.staticDir);

  auth.register(router);
  registerConversations(router, db, provider, storage, log);
  const chat = registerChat(router, db, provider, storage, { log });
  registerFiles(router, db, storage, log);
  registerImport(router, db, storage);
  router.add('GET', '/api/models', ({ res }) => sendJson(res, 200, { models: provider.models }), { auth: true });
  router.add(
    'GET',
    '/api/health',
    async ({ res }) => {
      await db.query('SELECT 1');
      sendJson(res, 200, { ok: true });
    },
    { auth: false },
  );

  const clientIp = (req: IncomingMessage): string => {
    if (config.TRUST_PROXY) {
      const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  /**
   * Defesa CSRF complementar a SameSite=Lax: pedidos que alteram estado têm de
   * vir da própria origem (cabeçalho Origin, ou Sec-Fetch-Site em último caso).
   */
  const checkOrigin = (req: IncomingMessage) => {
    if (SAFE_METHODS.has(req.method ?? 'GET')) return;
    const origin = req.headers.origin;
    const expected = config.PUBLIC_ORIGIN ?? `${config.cookieSecure ? 'https' : 'http'}://${req.headers.host}`;
    if (origin) {
      if (origin !== expected) throw new HttpError(403, 'bad_origin', 'Origem do pedido não permitida.');
      return;
    }
    if (req.headers['sec-fetch-site'] === 'same-origin') return;
    throw new HttpError(403, 'bad_origin', 'Origem do pedido em falta.');
  };

  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        checkOrigin(req);
        const match = router.match(req.method ?? 'GET', url.pathname);
        if (match === null) throw new HttpError(404, 'not_found', 'Recurso inexistente.');
        if (match === 'method-not-allowed') throw new HttpError(405, 'method_not_allowed', 'Método não suportado.');
        const user = await auth.authenticate(req);
        if (match.route.auth && !user) {
          throw new HttpError(401, 'unauthenticated', 'Sessão inválida ou expirada.', { 'Set-Cookie': auth.clearCookie() });
        }
        await match.route.handler({ req, res, params: match.params, url, ip: clientIp(req), user });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Método não suportado.');
      await serveStatic(url.pathname, res);
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendError(res, err);
        else res.end();
        return;
      }
      log(`[erro] ${req.method} ${url.pathname}: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) sendError(res, new HttpError(500, 'internal', 'Erro interno.'));
      else res.end();
    }
  });

  return { server, shutdown: () => chat.shutdown() };
}
