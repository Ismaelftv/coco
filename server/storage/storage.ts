/**
 * Armazenamento de objetos. A implementação local grava em disco fora da raiz
 * web, com chaves geradas pelo servidor (nunca derivadas do nome do ficheiro).
 * Em produção, uma implementação S3 (ou compatível) cumpre a mesma interface.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ObjectStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[a-f0-9-]{36}$/;

export function createLocalStorage(dir: string): ObjectStorage {
  const root = resolve(dir);
  const pathFor = (key: string) => {
    if (!KEY_RE.test(key)) throw new Error('Chave de armazenamento inválida');
    // Dois níveis de diretório para não acumular milhares de ficheiros numa pasta.
    return join(root, key.slice(0, 2), key);
  };
  return {
    async put(key, data) {
      const target = pathFor(key);
      await mkdir(join(root, key.slice(0, 2)), { recursive: true, mode: 0o700 });
      const tmp = join(root, `.tmp-${randomUUID()}`);
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, target); // escrita atómica
    },
    get: (key) => readFile(pathFor(key)),
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}
