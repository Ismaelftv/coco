/**
 * Configuração a partir de variáveis de ambiente, validada no arranque.
 * Uma configuração inválida impede o servidor de arrancar (falha cedo).
 */
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5173),
  DATABASE_URL: z.string().url(),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  /** Origem pública da aplicação (ex.: https://forja.exemplo). Usada na verificação CSRF. */
  PUBLIC_ORIGIN: z.string().url().optional(),
  COOKIE_SECURE: bool.optional(),
  ALLOW_SIGNUP: bool.default('true'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  STORAGE_DIR: z.string().default('./data/files'),
  /** Custo do scrypt (log2 de N). 17 em produção; os testes usam menos. */
  SCRYPT_LOG_N: z.coerce.number().int().min(12).max(20).default(17),
  TRUST_PROXY: bool.default('false'),
  /** Contas novas por IP por hora e tentativas de login por IP por minuto. */
  SIGNUP_PER_IP_HOUR: z.coerce.number().int().min(1).default(10),
  LOGIN_PER_IP_MINUTE: z.coerce.number().int().min(1).default(20),
  MOCK_DELAY_MS: z.coerce.number().int().min(0).max(5000).default(14),
});

export type Config = z.infer<typeof schema> & { cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production') {
    if (!c.PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN é obrigatório em produção.');
    if (c.COOKIE_SECURE === false) throw new Error('COOKIE_SECURE=false não é permitido em produção.');
    if (c.SCRYPT_LOG_N < 17) throw new Error('SCRYPT_LOG_N deve ser ≥ 17 em produção.');
  }
  return { ...c, cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production' };
}
