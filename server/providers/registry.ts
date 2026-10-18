/**
 * Registo de modelos: agrega o simulador e os backends declarados no catálogo
 * numa única ModelProvider. A aplicação não sabe que servidor responde a cada
 * modelo — trocar de modelo ou de servidor é uma alteração de configuração.
 */
import type { ModelInfo } from '../../shared/contract.ts';
import type { BackendConfig, Catalog, ModelConfig } from './catalog.ts';
import { createOllamaBackend } from './ollama.ts';
import { createOpenAICompatibleBackend } from './openai-compatible.ts';
import type { ModelBackend, ModelLimits, ModelProvider, ProviderEvent, ProviderRequest } from './types.ts';

export interface RegistryOptions {
  catalog: Catalog;
  /** Fornecedor simulado (desenvolvimento/testes). Omitir para não o expor. */
  simulator?: ModelProvider;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Para testes: substituir a criação de backends. */
  createBackend?: (config: BackendConfig, apiKey: string | undefined) => ModelBackend;
}

export interface ModelRegistry extends ModelProvider {
  /** Verifica os servidores de modelos e atualiza o estado de cada modelo. */
  refresh(): Promise<void>;
  /** Verificação periódica; devolve a função para parar. */
  startHealthChecks(intervalMs: number): () => void;
}

interface Entry {
  config: ModelConfig;
  backend: ModelBackend;
  hosting: BackendConfig['hosting'];
  status: ModelInfo['status'];
  statusDetail: string | null;
}

const SIMULATOR_LIMITS: ModelLimits = { contextTokens: 32_000, maxOutputTokens: 4_096 };

/** O Ollama lista "qwen3:4b"; "qwen3" equivale a "qwen3:latest". */
function sameModel(upstream: string, listed: string): boolean {
  const norm = (s: string) => (s.includes(':') ? s : `${s}:latest`);
  return norm(upstream) === norm(listed);
}

export function createModelRegistry(options: RegistryOptions): ModelRegistry {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const backends = new Map<string, { backend: ModelBackend; config: BackendConfig }>();

  for (const b of options.catalog.backends) {
    const apiKey = b.apiKeyEnv ? env[b.apiKeyEnv] : undefined;
    if (b.apiKeyEnv && !apiKey) {
      // Integrações com chave são opcionais: sem chave, o backend simplesmente não é registado.
      log(`[modelos] backend "${b.id}" ignorado: variável ${b.apiKeyEnv} não definida.`);
      continue;
    }
    const common = {
      id: b.id,
      baseUrl: b.baseUrl,
      apiKey,
      ...(b.headersTimeoutMs ? { headersTimeoutMs: b.headersTimeoutMs } : {}),
      ...(b.idleTimeoutMs ? { idleTimeoutMs: b.idleTimeoutMs } : {}),
      ...(b.extraBody ? { extraBody: b.extraBody } : {}),
      log,
    };
    const backend = options.createBackend
      ? options.createBackend(b, apiKey)
      : b.kind === 'ollama'
        ? createOllamaBackend(common)
        : createOpenAICompatibleBackend(common);
    backends.set(b.id, { backend, config: b });
  }

  const entries = new Map<string, Entry>();
  for (const m of options.catalog.models) {
    const b = backends.get(m.backend);
    if (!b) continue; // backend ignorado por falta de chave
    entries.set(m.id, {
      config: m,
      backend: b.backend,
      hosting: b.config.hosting,
      status: 'offline',
      statusDetail: 'A verificar o servidor de modelos…',
    });
  }

  const info = (e: Entry): ModelInfo => ({
    id: e.config.id,
    label: e.config.label,
    description: e.config.description,
    status: e.status,
    hosting: e.hosting,
    author: e.config.author,
    license: e.config.license,
    statusDetail: e.statusDetail,
  });

  async function refresh(): Promise<void> {
    const byBackend = new Map<ModelBackend, string[] | null>();
    await Promise.all(
      [...new Set([...entries.values()].map((e) => e.backend))].map(async (b) => {
        byBackend.set(b, await b.listUpstreamModels(AbortSignal.timeout(6_000)));
      }),
    );
    for (const e of entries.values()) {
      const listed = byBackend.get(e.backend);
      const before = e.status;
      if (listed === null || listed === undefined) {
        e.status = 'offline';
        e.statusDetail = 'O servidor de modelos não está acessível.';
      } else if (!listed.some((l) => sameModel(e.config.upstreamModel, l))) {
        e.status = 'offline';
        e.statusDetail = `O modelo "${e.config.upstreamModel}" não está instalado no servidor de modelos.`;
      } else {
        e.status = 'available';
        e.statusDetail = null;
      }
      if (before !== e.status) log(`[modelos] ${e.config.id}: ${before} → ${e.status}`);
    }
  }

  return {
    get models(): ModelInfo[] {
      // Modelos próprios primeiro; o simulador por último.
      return [...[...entries.values()].map(info), ...(options.simulator?.models ?? [])];
    },

    limits(model: string): ModelLimits | undefined {
      const e = entries.get(model);
      if (e) return { contextTokens: e.config.contextTokens, maxOutputTokens: e.config.maxOutputTokens };
      return options.simulator?.models.some((m) => m.id === model) ? SIMULATOR_LIMITS : undefined;
    },

    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      const e = entries.get(request.model);
      if (!e) {
        if (options.simulator?.models.some((m) => m.id === request.model)) {
          yield* options.simulator.stream(request, signal);
          return;
        }
        yield { type: 'error', code: 'unknown_model', message: 'Modelo desconhecido.', retryable: false };
        return;
      }
      const maxOutputTokens = Math.min(request.maxOutputTokens ?? e.config.maxOutputTokens, e.config.maxOutputTokens);
      const temperature = request.temperature ?? e.config.temperature;
      for await (const ev of e.backend.stream(
        {
          ...request,
          upstreamModel: e.config.upstreamModel,
          contextTokens: e.config.contextTokens,
          think: e.config.think,
          maxOutputTokens,
          ...(temperature !== undefined ? { temperature } : {}),
        },
        signal,
      )) {
        // Uma falha de ligação marca o modelo como indisponível até à próxima verificação.
        if (ev.type === 'error' && ev.code === 'model_offline') {
          e.status = 'offline';
          e.statusDetail = 'O servidor de modelos não está acessível.';
        }
        yield ev;
      }
    },

    refresh,

    startHealthChecks(intervalMs: number) {
      const timer = setInterval(() => {
        refresh().catch((err: Error) => log(`[modelos] verificação falhou: ${err.message}`));
      }, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
