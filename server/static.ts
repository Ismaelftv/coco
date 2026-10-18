import type { ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { HttpError } from './http/http.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Serve o build do frontend; rotas sem extensão recebem index.html (SPA). */
export function createStatic(dir: string) {
  const root = resolve(dir);
  return async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'bad_path', 'Caminho inválido.');
    }
    const candidate = normalize(join(root, decoded));
    if (candidate !== root && !candidate.startsWith(root + sep)) throw new HttpError(403, 'forbidden', 'Proibido.');
    let file = candidate;
    const info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) {
      if (extname(decoded)) throw new HttpError(404, 'not_found', 'Não encontrado.');
      file = join(root, 'index.html');
    }
    const data = await readFile(file).catch(() => null);
    if (!data) throw new HttpError(404, 'not_found', 'Build em falta. Corre `npm run build`.');
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(data);
  };
}
