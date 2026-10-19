/**
 * Classificação determinista da CAUSA de uma execução, a partir de factos do relatório
 * (nunca do que o modelo diz). Serve para não misturar numa só taxa de "falhas":
 * o modelo que não age, a ferramenta que recusa, o tempo que acaba, o código que não
 * passa nos testes, a violação de integridade e os problemas de infraestrutura.
 */
import type { AgentReport } from './loop.ts';

export type Outcome =
  | 'success'
  | 'timeout' // limite de tempo ou de tokens esgotado (em CPU mede o hardware, não só o modelo)
  | 'edit_refused' // o modelo tentou alterar, a ferramenta RECUSOU corretamente (ambiguidade, contexto desatualizado, parâmetros inconsistentes) e o modelo não resolveu; nada foi alterado
  | 'tool_failure' // a ferramenta FALHOU (E/S, verificação após escrita, erro interno) e não houve alterações
  | 'model_no_action' // sem alterações e sem tentativas de escrita recusadas
  | 'tests_failed' // houve alterações mas os testes (critério de execução) falham
  | 'integrity_violation' // os testes passam mas um critério de integridade falhou (p. ex. testes alterados)
  | 'model_error' // o servidor do modelo falhou
  | 'infrastructure'; // sandbox insuficiente, etc.

export interface OutcomeInfo {
  outcome: Outcome;
  detail: string;
}

const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'delete_file']);
/** Códigos de recusa legítima: a ferramenta fez o seu trabalho; o que falta é o modelo corrigir o pedido. */
const REFUSAL_CODES = new Set(['conflict', 'invalid', 'repeated']);

export function classifyOutcome(r: Pick<AgentReport, 'status' | 'stopReason' | 'steps' | 'changedFiles' | 'criteria'>): OutcomeInfo {
  if (r.status === 'succeeded') return { outcome: 'success', detail: 'critérios de execução cumpridos e verificados pelo sistema' };
  if (r.stopReason === 'sandbox_insufficient') return { outcome: 'infrastructure', detail: 'isolamento insuficiente: nada foi executado' };
  if (r.stopReason === 'timeout' || r.stopReason === 'token_budget') return { outcome: 'timeout', detail: r.stopReason === 'timeout' ? 'tempo total esgotado' : 'orçamento de tokens esgotado' };
  if (r.stopReason === 'model_error') return { outcome: 'model_error', detail: 'o servidor de modelos devolveu erro' };
  const writeFailures = r.steps.filter((s) => s.kind === 'tool' && s.tool && WRITE_TOOLS.has(s.tool) && s.ok === false);
  const changed = r.changedFiles.length > 0;
  if (!changed) {
    if (writeFailures.length > 0) {
      const codes = [...new Set(writeFailures.map((s) => `${s.tool}:${s.errorCode ?? '?'}`))].join(', ');
      const refusalsOnly = writeFailures.every((s) => REFUSAL_CODES.has(s.errorCode ?? ''));
      return { outcome: refusalsOnly ? 'edit_refused' : 'tool_failure', detail: `${writeFailures.length} tentativa(s) de escrita ${refusalsOnly ? 'recusadas pela ferramenta' : 'falhadas'} (${codes}) e nenhuma alteração aplicada` };
    }
    return { outcome: 'model_no_action', detail: `sem alterações (${r.stopReason})` };
  }
  const failed = r.criteria.filter((c) => !c.passed);
  const testsFailed = failed.some((c) => c.criterion.type === 'command');
  if (testsFailed || failed.length === 0) return { outcome: 'tests_failed', detail: failed.length ? failed.map((c) => `${c.criterion.type}: ${c.evidence.split('\n')[0]}`).join('; ').slice(0, 300) : `alterações feitas mas conclusão não verificada (${r.stopReason})` };
  return { outcome: 'integrity_violation', detail: failed.map((c) => `${c.criterion.type}: ${c.evidence.split('\n')[0]}`).join('; ').slice(0, 300) };
}
