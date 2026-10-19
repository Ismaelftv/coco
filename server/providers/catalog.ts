/**
 * Catálogo de modelos declarado em ficheiro (MODELS_CONFIG), validado no arranque.
 *
 * Segredos: o ficheiro só guarda o NOME da variável de ambiente com a chave
 * (`apiKeyEnv`). O valor é lido do ambiente do servidor e nunca sai dele.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+(\.internal|\.local|\.svc(\.cluster\.local)?)?)$/i;

/** Regras de segurança do endereço de um servidor (modelos de texto ou de imagem). */
function checkBackendUrl(b: { baseUrl: string; hosting: 'self-hosted' | 'external' }, who: string, ctx: z.RefinementCtx) {
  const url = new URL(b.baseUrl);
  // Tráfego para fora da nossa rede tem de ir cifrado.
  if (url.protocol !== 'https:' && !PRIVATE_HOST.test(url.hostname)) {
    ctx.addIssue({ code: 'custom', message: `${who}: HTTP sem TLS só é aceite para endereços locais ou privados.` });
  }
  if (b.hosting === 'external' && url.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', message: `${who}: serviços externos exigem HTTPS.` });
  }
  if (url.username || url.password) {
    ctx.addIssue({ code: 'custom', message: `${who}: credenciais no URL não são permitidas; usa apiKeyEnv.` });
  }
}

export const backendSchema = z
  .object({
    id: z.string().regex(MODEL_ID),
    /**
     * `ollama`: API nativa do Ollama (controla contexto e raciocínio por pedido).
     * `openai-compatible`: /v1/chat/completions (vLLM, llama.cpp, SGLang, APIs comerciais).
     */
    kind: z.enum(['ollama', 'openai-compatible']),
    /** Ollama: http://127.0.0.1:11434 · compatível com OpenAI: URL terminado em /v1 (ex.: http://host:8000/v1). */
    baseUrl: z.string().url(),
    /** `self-hosted`: infraestrutura nossa. `external`: API de terceiros (opcional). */
    hosting: z.enum(['self-hosted', 'external']),
    apiKeyEnv: z.string().regex(ENV_NAME, 'Nome de variável de ambiente inválido.').optional(),
    headersTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    idleTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    /** Campos extra para o corpo do pedido, específicos do servidor. */
    extraBody: z.record(z.unknown()).optional(),
  })
  .superRefine((b, ctx) => checkBackendUrl(b, `Backend "${b.id}"`, ctx));

export const modelSchema = z.object({
  /** Id público na Forja (o que o frontend vê). */
  id: z.string().regex(MODEL_ID),
  label: z.string().min(1).max(60),
  description: z.string().max(200).default(''),
  backend: z.string(),
  /** Nome do modelo no servidor de modelos (ex.: "qwen3:4b"). Não é exposto ao frontend. */
  upstreamModel: z.string().min(1).max(200),
  author: z.string().max(80).nullable().default(null),
  license: z.string().max(80).nullable().default(null),
  contextTokens: z.number().int().min(1_024).max(2_000_000),
  maxOutputTokens: z.number().int().min(16).max(200_000),
  temperature: z.number().min(0).max(2).optional(),
  /** Raciocínio explícito ("thinking"). Desligado por defeito: em CPU consome muito tempo e tokens. */
  think: z.boolean().default(false),
  /**
   * `native`: usa o suporte de ferramentas do servidor (Ollama `tools`; vLLM com
   * --enable-auto-tool-choice). `prompted`: protocolo JSON da Forja, funciona com qualquer modelo.
   */
  toolCalling: z.enum(['native', 'prompted']).default('prompted'),
});

/**
 * Geração de imagens (opcional): um servidor com a API `POST {baseUrl}/images/generations` compatível com a
 * OpenAI (LocalAI, entre outros). Sem esta secção, o botão "Criar imagem" não aparece.
 */
export const imageBackendSchema = z
  .object({
    label: z.string().min(1).max(60).default('Imagens locais'),
    /** URL terminado em /v1 (ex.: http://127.0.0.1:8080/v1). */
    baseUrl: z.string().url(),
    hosting: z.enum(['self-hosted', 'external']),
    /** Nome do modelo de imagem no servidor. */
    model: z.string().min(1).max(200),
    apiKeyEnv: z.string().regex(ENV_NAME, 'Nome de variável de ambiente inválido.').optional(),
    /** Tamanho pedido (LxA). Em CPU, tamanhos pequenos são muito mais rápidos. */
    size: z.string().regex(/^\d{3,4}x\d{3,4}$/, 'Formato LxA, ex.: 512x512').default('512x512'),
    /** Em CPU uma imagem pode demorar vários minutos. */
    timeoutMs: z.number().int().min(10_000).max(1_800_000).default(900_000),
    extraBody: z.record(z.unknown()).optional(),
  })
  .superRefine((b, ctx) => checkBackendUrl(b, 'Imagens', ctx));

export const catalogSchema = z
  .object({
    backends: z.array(backendSchema).default([]),
    models: z.array(modelSchema).default([]),
    images: imageBackendSchema.optional(),
  })
  .superRefine((c, ctx) => {
    const backends = new Set<string>();
    for (const b of c.backends) {
      if (backends.has(b.id)) ctx.addIssue({ code: 'custom', message: `Backend duplicado: ${b.id}` });
      backends.add(b.id);
    }
    const models = new Set<string>(['forja-sim']);
    for (const m of c.models) {
      if (models.has(m.id)) ctx.addIssue({ code: 'custom', message: `Modelo duplicado ou reservado: ${m.id}` });
      models.add(m.id);
      if (!backends.has(m.backend)) ctx.addIssue({ code: 'custom', message: `Modelo "${m.id}" refere um backend inexistente: ${m.backend}` });
      if (m.maxOutputTokens >= m.contextTokens) {
        ctx.addIssue({ code: 'custom', message: `Modelo "${m.id}": maxOutputTokens tem de ser menor do que contextTokens.` });
      }
    }
  });

export type BackendConfig = z.infer<typeof backendSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;
export type ImageBackendConfig = z.infer<typeof imageBackendSchema>;
export type Catalog = z.infer<typeof catalogSchema>;

export function parseCatalog(json: unknown, source = 'catálogo'): Catalog {
  const parsed = catalogSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(raiz)'}: ${i.message}`).join('\n');
    throw new Error(`Catálogo de modelos inválido (${source}):\n${issues}`);
  }
  return parsed.data;
}

export async function loadCatalog(path: string): Promise<Catalog> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    throw new Error(`Não foi possível ler MODELS_CONFIG (${path}): ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`MODELS_CONFIG (${path}) não é JSON válido.`);
  }
  return parseCatalog(json, path);
}
