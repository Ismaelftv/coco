import type { ChatMessage } from '../shared/contract.ts';

/**
 * Estimativa grosseira (≈4 caracteres por token em texto latino).
 * Substituir pelo tokenizador do modelo ativo na Fase 4.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageTokens(m: ChatMessage): number {
  const attached = (m.attachments ?? []).reduce((n, a) => n + estimateTokens(a.content), 0);
  return estimateTokens(m.content) + attached + 4;
}

/**
 * Mantém as mensagens mais recentes que cabem no orçamento de tokens.
 * A última mensagem (do utilizador) é sempre incluída.
 * O histórico começa sempre numa mensagem do utilizador, para não enviar
 * uma resposta do assistente sem a pergunta correspondente.
 */
export function trimHistory(messages: ChatMessage[], budgetTokens: number): ChatMessage[] {
  if (messages.length === 0) return [];
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const cost = messageTokens(m);
    if (kept.length > 0 && used + cost > budgetTokens) break;
    kept.unshift(m);
    used += cost;
  }
  while (kept.length > 1 && kept[0]?.role !== 'user') kept.shift();
  return kept;
}
