/**
 * Modelo roteirizado para testes determinísticos do ciclo de agentes.
 * Cada resposta é dada por um passo do roteiro (ou por uma função que vê o
 * pedido). Não pretende ser "inteligente": serve para verificar o
 * comportamento do SISTEMA (validação, permissões, limites, critérios) em
 * cenários controlados, incluindo modelos que erram.
 */
import type { ToolCall } from '../../shared/contract.ts';
import type { ModelLimits, ModelProvider, ProviderEvent, ProviderRequest } from '../../server/providers/types.ts';

export type ScriptedReply =
  | { text?: string; calls?: { name: string; arguments?: unknown }[]; delayMs?: number; outputTokens?: number }
  | { error: string; retryable?: boolean };

export type ScriptStep = ScriptedReply | ((request: ProviderRequest, turn: number) => ScriptedReply);

export interface ScriptedProvider extends ModelProvider {
  requests: ProviderRequest[];
}

export const tool = (name: string, args: unknown = {}): ScriptedReply => ({ calls: [{ name, arguments: args }] });
/** Chamada escrita em texto (protocolo textual da Forja). */
export const textTool = (name: string, args: unknown = {}, before = ''): ScriptedReply => ({
  text: `${before}\n\`\`\`json\n${JSON.stringify({ tool: name, args })}\n\`\`\``,
});

export function createScriptedProvider(script: ScriptStep[], opts: { limits?: Partial<ModelLimits>; fallback?: ScriptStep } = {}): ScriptedProvider {
  const requests: ProviderRequest[] = [];
  let turn = 0;
  const limits: ModelLimits = { contextTokens: 32_768, maxOutputTokens: 2048, toolCalling: 'native', ...opts.limits };
  return {
    requests,
    models: [{ id: 'roteiro', label: 'Modelo roteirizado (testes)', description: '', hosting: 'simulated', status: 'available' } as never],
    limits: () => limits,
    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      requests.push(structuredClone(request));
      const step = script[turn] ?? opts.fallback ?? { text: '(fim do roteiro)' };
      const reply = typeof step === 'function' ? step(request, turn) : step;
      turn++;
      if ('error' in reply) {
        yield { type: 'error', code: 'model_error', message: reply.error, retryable: reply.retryable ?? false };
        return;
      }
      if (reply.delayMs) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, reply.delayMs);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
        if (signal.aborted) {
          yield { type: 'end', finishReason: 'cancelled', usage: { inputTokens: 0, outputTokens: 0, estimated: true } };
          return;
        }
      }
      if (reply.text) yield { type: 'delta', text: reply.text };
      for (const [i, c] of (reply.calls ?? []).entries()) {
        const call: ToolCall = { id: `call_${turn}_${i}`, name: c.name, arguments: c.arguments ?? {} };
        yield { type: 'tool_call', call };
      }
      const input = JSON.stringify(request.messages).length / 4;
      yield { type: 'end', finishReason: 'stop', usage: { inputTokens: Math.ceil(input), outputTokens: reply.outputTokens ?? 20, estimated: false } };
    },
  };
}
