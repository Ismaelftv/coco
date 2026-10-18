/**
 * Hash de palavras-passe com scrypt (nativo do Node; parâmetros recomendados
 * pela OWASP: N=2^17, r=8, p=1). O formato inclui os parâmetros para permitir
 * aumentá-los no futuro e migrar para argon2id sem invalidar contas.
 *
 *   scrypt$<logN>$<r>$<p>$<salt base64>$<hash base64>
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const KEY_LEN = 32;

function scrypt(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

function options(logN: number, r: number, p: number): ScryptOptions {
  const N = 2 ** logN;
  return { N, r, p, maxmem: 256 * N * r + 1024 * 1024 };
}

export async function hashPassword(password: string, logN: number): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, options(logN, 8, 1));
  return `scrypt$${logN}$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, logN, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64!, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64!, 'base64'), options(Number(logN), Number(r), Number(p)));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Indica se o hash usa parâmetros mais fracos do que os atuais (para re-hash no login). */
export function needsRehash(stored: string, logN: number): boolean {
  const n = Number(stored.split('$')[1]);
  return !Number.isFinite(n) || n < logN;
}
