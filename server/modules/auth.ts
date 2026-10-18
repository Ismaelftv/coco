/**
 * Contas e sessões.
 * - Sessões opacas: token aleatório de 256 bits no cookie; só o SHA-256 é guardado.
 * - Cookie HttpOnly + SameSite=Lax (+ Secure e prefixo __Host- em produção).
 * - Expiração deslizante com renovação no máximo uma vez por hora.
 * - Login com tempo semelhante para contas existentes e inexistentes.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { LIMITS, loginSchema, signupSchema, type User } from '../../shared/contract.ts';
import type { Config } from '../config.ts';
import { PgError, type Db } from '../db/db.ts';
import { HttpError, parseCookies, readJson, sendJson, serializeCookie, type Router } from '../http/http.ts';
import { createRateLimiter } from '../rate-limit.ts';
import { hashPassword, needsRehash, verifyPassword } from '../security/password.ts';
import { audit } from './audit.ts';

export interface AuthUser {
  id: string;
  email: string;
}

const RENEW_AFTER_MS = 60 * 60 * 1000;

export function sessionCookieName(config: Config): string {
  return config.cookieSecure ? '__Host-forja_session' : 'forja_session';
}

const hashToken = (token: string) => createHash('sha256').update(token).digest();

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string;
  created_at: Date;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  createdAt: r.created_at.toISOString(),
});

export function createAuth(db: Db, config: Config) {
  const cookieName = sessionCookieName(config);
  const ttlMs = config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  // Hash de referência para equalizar o tempo de resposta quando o email não existe.
  const dummyHash = hashPassword('forja-dummy-password', config.SCRYPT_LOG_N);
  const perIp = createRateLimiter(config.LOGIN_PER_IP_MINUTE, config.LOGIN_PER_IP_MINUTE / 60);
  const perEmail = createRateLimiter(5, 5 / 300);
  const signupPerIp = createRateLimiter(config.SIGNUP_PER_IP_HOUR, config.SIGNUP_PER_IP_HOUR / 3600);

  async function createSession(userId: string, req: IncomingMessage, ip: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await db.query(
      'INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip) VALUES ($1, $2, $3, $4, $5)',
      [hashToken(token), userId, new Date(Date.now() + ttlMs), (req.headers['user-agent'] ?? '').slice(0, 300), ip],
    );
    return token;
  }

  function cookie(token: string): string {
    return serializeCookie(cookieName, token, { secure: config.cookieSecure, maxAgeSeconds: Math.floor(ttlMs / 1000) });
  }

  const clearCookie = () => serializeCookie(cookieName, '', { secure: config.cookieSecure, maxAgeSeconds: 0 });

  /** Resolve o utilizador a partir do cookie; renova a sessão se for altura. */
  async function authenticate(req: IncomingMessage): Promise<AuthUser | null> {
    const token = parseCookies(req.headers.cookie)[cookieName];
    if (!token || token.length > 100) return null;
    const r = await db.query<{ id: string; email: string; last_seen_at: Date }>(
      `SELECT u.id, u.email, s.last_seen_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (Date.now() - row.last_seen_at.getTime() > RENEW_AFTER_MS) {
      await db.query('UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE token_hash = $1', [
        hashToken(token),
        new Date(Date.now() + ttlMs),
      ]);
    }
    return { id: row.id, email: row.email };
  }

  function register(router: Router<AuthUser | null>) {
    router.add(
      'POST',
      '/api/auth/signup',
      async ({ req, res, ip }) => {
        if (!config.ALLOW_SIGNUP) throw new HttpError(403, 'signup_disabled', 'O registo está desativado.');
        if (!signupPerIp.take(ip)) throw new HttpError(429, 'rate_limited', 'Demasiadas contas criadas. Tenta mais tarde.', { 'Retry-After': '600' });
        const body = await readJson(req, signupSchema, LIMITS.jsonBodyBytes);
        const local = body.email.split('@')[0]!;
        if (local.length >= 4 && body.password.toLowerCase().includes(local)) {
          throw new HttpError(422, 'weak_password', 'A palavra-passe não pode conter o teu email.');
        }
        const id = randomUUID();
        const hash = await hashPassword(body.password, config.SCRYPT_LOG_N);
        let row: UserRow;
        try {
          const r = await db.query<UserRow>(
            `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)
             RETURNING id, email, display_name, password_hash, created_at`,
            [id, body.email, body.displayName ?? null, hash],
          );
          row = r.rows[0]!;
        } catch (e) {
          if (e instanceof PgError && e.code === '23505') {
            throw new HttpError(409, 'email_taken', 'Já existe uma conta com este email.');
          }
          throw e;
        }
        await audit(db, { userId: id, action: 'auth.signup', ip });
        const token = await createSession(id, req, ip);
        sendJson(res, 201, { user: toUser(row) }, { 'Set-Cookie': cookie(token) });
      },
      { auth: false },
    );

    router.add(
      'POST',
      '/api/auth/login',
      async ({ req, res, ip }) => {
        if (!perIp.take(ip)) throw new HttpError(429, 'rate_limited', 'Demasiadas tentativas. Tenta dentro de um minuto.', { 'Retry-After': '60' });
        const body = await readJson(req, loginSchema, LIMITS.jsonBodyBytes);
        if (!perEmail.take(body.email)) {
          throw new HttpError(429, 'rate_limited', 'Demasiadas tentativas para esta conta. Tenta mais tarde.', { 'Retry-After': '300' });
        }
        const r = await db.query<UserRow>(
          'SELECT id, email, display_name, password_hash, created_at FROM users WHERE email = $1',
          [body.email],
        );
        const row = r.rows[0];
        const ok = await verifyPassword(body.password, row?.password_hash ?? (await dummyHash));
        if (!row || !ok) {
          await audit(db, { userId: row?.id ?? null, action: 'auth.login_failed', ip });
          throw new HttpError(401, 'invalid_credentials', 'Email ou palavra-passe incorretos.');
        }
        if (needsRehash(row.password_hash, config.SCRYPT_LOG_N)) {
          await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
            row.id,
            await hashPassword(body.password, config.SCRYPT_LOG_N),
          ]);
        }
        await audit(db, { userId: row.id, action: 'auth.login', ip });
        const token = await createSession(row.id, req, ip);
        sendJson(res, 200, { user: toUser(row) }, { 'Set-Cookie': cookie(token) });
      },
      { auth: false },
    );

    router.add(
      'POST',
      '/api/auth/logout',
      async ({ req, res, ip, user }) => {
        const token = parseCookies(req.headers.cookie)[cookieName];
        if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
        if (user) await audit(db, { userId: user.id, action: 'auth.logout', ip });
        res.writeHead(204, { 'Set-Cookie': clearCookie(), 'Cache-Control': 'no-store' });
        res.end();
      },
      { auth: false },
    );

    router.add(
      'GET',
      '/api/auth/me',
      async ({ res, user }) => {
        const r = await db.query<UserRow>(
          'SELECT id, email, display_name, password_hash, created_at FROM users WHERE id = $1',
          [user!.id],
        );
        sendJson(res, 200, { user: toUser(r.rows[0]!), signupEnabled: config.ALLOW_SIGNUP });
      },
      { auth: true },
    );

    router.add(
      'GET',
      '/api/auth/config',
      ({ res }) => sendJson(res, 200, { signupEnabled: config.ALLOW_SIGNUP }),
      { auth: false },
    );
  }

  return { authenticate, register, clearCookie };
}
