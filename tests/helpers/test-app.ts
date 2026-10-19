/** Arranca a aplicação completa contra uma base de dados descartável. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.ts';
import { loadConfig } from '../../server/config.ts';
import { createMockProvider } from '../../server/providers/mock.ts';
import type { ImageGenerator } from '../../server/providers/images.ts';
import type { ModelProvider } from '../../server/providers/types.ts';
import { createLocalStorage } from '../../server/storage/storage.ts';
import { createTestDatabase } from './test-db.ts';

export async function startTestApp(
  opts: { staticDir?: string; delayMs?: number; env?: Record<string, string>; provider?: ModelProvider; images?: ImageGenerator | null } = {},
) {
  const database = await createTestDatabase();
  const storageDir = await mkdtemp(join(tmpdir(), 'forja-files-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: database.url,
    SCRYPT_LOG_N: '12',
    COOKIE_SECURE: 'false',
    STORAGE_DIR: storageDir,
    SIGNUP_PER_IP_HOUR: '10000',
    LOGIN_PER_IP_MINUTE: '10000',
    ...opts.env,
  });
  const storage = createLocalStorage(storageDir);
  const logs: string[] = [];
  const app = createApp({
    config,
    db: database.db,
    provider: opts.provider ?? createMockProvider({ delayMs: opts.delayMs ?? 0 }),
    storage,
    images: opts.images ?? null,
    staticDir: opts.staticDir ?? storageDir,
    log: (l) => logs.push(l),
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {
    base,
    db: database.db,
    storage,
    storageDir,
    logs,
    async stop() {
      await app.shutdown();
      app.server.closeAllConnections();
      await new Promise<void>((r) => app.server.close(() => r()));
      await database.drop();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

/** Cliente HTTP com cookie de sessão e cabeçalho Origin, como um navegador. */
export class Client {
  cookie = '';
  constructor(readonly base: string) {}

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const isRaw = Buffer.isBuffer(body);
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Origin: this.base,
        ...(body !== undefined && !isRaw ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isRaw ? new Uint8Array(body) : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!;
    return res;
  }

  async json<T = Record<string, unknown>>(method: string, path: string, body?: unknown) {
    const res = await this.request(method, path, body);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  }

  async signup(email: string, password = 'palavra-passe-segura-1') {
    const r = await this.json('POST', '/api/auth/signup', { email, password });
    if (r.status !== 201) throw new Error(`signup falhou: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as { user: { id: string } };
  }
}

export interface SseEvent {
  type: string;
  data: Record<string, unknown>;
}

export function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((block) => {
      const type = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? '{}';
      return { type, data: JSON.parse(data) as Record<string, unknown> };
    });
}
