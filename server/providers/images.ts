/**
 * Cliente de geração de imagens: `POST {baseUrl}/images/generations` (formato da OpenAI; LocalAI e outros).
 *
 * Segurança:
 *  - o servidor de imagens é configurado pelo administrador (catálogo), nunca pelo utilizador;
 *  - só se aceita a imagem devolvida em base64 ou num URL da MESMA origem do servidor configurado
 *    (nunca se segue um URL arbitrário devolvido pelo servidor: evita SSRF);
 *  - os bytes são verificados pelo conteúdo (têm de ser mesmo uma imagem) e o tamanho é limitado;
 *  - a chave, se existir, vem de uma variável de ambiente do servidor e nunca sai dele.
 */
import { LIMITS } from '../../shared/limits.ts';
import type { ImageBackendConfig } from './catalog.ts';
import { classify } from '../storage/sniff.ts';

export class ImageError extends Error {
  constructor(
    readonly code: 'image_unavailable' | 'image_timeout' | 'image_rejected' | 'image_bad_response' | 'cancelled',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface GeneratedImage {
  data: Buffer;
  mediaType: string;
}

export interface ImageGenerator {
  readonly label: string;
  readonly size: string;
  readonly model: string;
  generate(prompt: string, signal: AbortSignal): Promise<GeneratedImage>;
}

const MAX_RESPONSE_BYTES = Math.ceil(LIMITS.binaryFileBytes * 1.5) + 4096; // base64 + envelope JSON

async function readLimited(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) throw new ImageError('image_bad_response', 'O servidor de imagens devolveu uma resposta demasiado grande.', 502);
  const chunks: Buffer[] = [];
  let total = 0;
  if (!res.body) return Buffer.alloc(0);
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > max) throw new ImageError('image_bad_response', 'O servidor de imagens devolveu uma resposta demasiado grande.', 502);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createImageGenerator(config: ImageBackendConfig, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): ImageGenerator {
  const base = config.baseUrl.replace(/\/+$/, '');
  const origin = new URL(config.baseUrl).origin;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKeyEnv) {
    const key = env[config.apiKeyEnv];
    if (key) headers.Authorization = `Bearer ${key}`;
  }

  const verify = (data: Buffer): GeneratedImage => {
    if (data.length === 0 || data.length > LIMITS.binaryFileBytes) {
      throw new ImageError('image_bad_response', 'A imagem devolvida está vazia ou excede o tamanho máximo.', 502);
    }
    const c = classify(data);
    if (!c.ok || c.detected.kind !== 'image') {
      throw new ImageError('image_bad_response', 'O servidor de imagens não devolveu uma imagem válida.', 502);
    }
    return { data, mediaType: c.detected.mediaType };
  };

  return {
    label: config.label,
    size: config.size,
    model: config.model,
    async generate(prompt, signal) {
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const combined = AbortSignal.any([signal, timeout]);
      const fail = (e: unknown): never => {
        if (e instanceof ImageError) throw e;
        if (signal.aborted) throw new ImageError('cancelled', 'Pedido cancelado.', 499);
        if (timeout.aborted) {
          throw new ImageError('image_timeout', `O servidor de imagens não respondeu em ${Math.round(config.timeoutMs / 60_000)} min.`, 504);
        }
        throw new ImageError('image_unavailable', 'O servidor de imagens está inacessível. Confirma que está a correr e o endereço no catálogo.', 502);
      };
      try {
        const res = await fetchImpl(`${base}/images/generations`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...config.extraBody, model: config.model, prompt, n: 1, size: config.size, response_format: 'b64_json' }),
          signal: combined,
          redirect: 'error',
        });
        if (!res.ok) {
          const text = (await readLimited(res, 8192).catch(() => Buffer.alloc(0))).toString('utf8').slice(0, 200).replace(/\s+/g, ' ');
          throw new ImageError('image_rejected', `O servidor de imagens recusou o pedido (HTTP ${res.status})${text ? `: ${text}` : '.'}`, 502);
        }
        let json: { data?: { b64_json?: unknown; url?: unknown }[] };
        try {
          json = JSON.parse((await readLimited(res, MAX_RESPONSE_BYTES)).toString('utf8'));
        } catch (e) {
          if (e instanceof ImageError) throw e;
          throw new ImageError('image_bad_response', 'Resposta do servidor de imagens ilegível.', 502);
        }
        const item = json.data?.[0];
        if (typeof item?.b64_json === 'string' && item.b64_json.length > 0) {
          return verify(Buffer.from(item.b64_json, 'base64'));
        }
        if (typeof item?.url === 'string') {
          // Só URLs da mesma origem do servidor configurado.
          let target: URL;
          try {
            target = new URL(item.url, `${origin}/`);
          } catch {
            throw new ImageError('image_bad_response', 'URL de imagem inválido.', 502);
          }
          if (target.origin !== origin) {
            throw new ImageError('image_bad_response', 'O servidor de imagens devolveu um URL de outra origem: recusado.', 502);
          }
          const img = await fetchImpl(target, { headers: config.apiKeyEnv && headers.Authorization ? { Authorization: headers.Authorization } : {}, signal: combined, redirect: 'error' });
          if (!img.ok) throw new ImageError('image_bad_response', `Não foi possível obter a imagem (HTTP ${img.status}).`, 502);
          return verify(await readLimited(img, LIMITS.binaryFileBytes + 1));
        }
        throw new ImageError('image_bad_response', 'A resposta do servidor de imagens não contém imagem.', 502);
      } catch (e) {
        return fail(e);
      }
    },
  };
}
