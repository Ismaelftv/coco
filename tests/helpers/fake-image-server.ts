/** Servidor de imagens falso (formato OpenAI `/v1/images/generations`) para testes. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0def46b80000000049454e44ae426082', 'hex');

export type FakeMode = 'ok' | 'http-error' | 'not-image' | 'cross-origin-url' | 'same-origin-url' | 'empty' | 'slow';

export async function startFakeImageServer(mode: FakeMode = 'ok') {
  const requests: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
  const state = { mode };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/files/img.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
        return;
      }
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* vazio */ }
      requests.push({ url: req.url ?? '', body, auth: req.headers.authorization });
      const json = (data: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      switch (state.mode) {
        case 'ok': return json({ data: [{ b64_json: PNG.toString('base64') }] });
        case 'http-error': return void res.writeHead(500).end('modelo não carregado');
        case 'not-image': return json({ data: [{ b64_json: Buffer.from('isto não é uma imagem').toString('base64') }] });
        case 'cross-origin-url': return json({ data: [{ url: 'http://127.0.0.1:1/x.png' }] });
        case 'same-origin-url': return json({ data: [{ url: '/files/img.png' }] });
        case 'empty': return json({ data: [] });
        case 'slow': {
          const t = setTimeout(() => json({ data: [{ b64_json: PNG.toString('base64') }] }), 5000);
          res.on('close', () => clearTimeout(t));
          return;
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    url,
    requests,
    setMode(m: FakeMode) { state.mode = m; },
    async stop() { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); },
  };
}
