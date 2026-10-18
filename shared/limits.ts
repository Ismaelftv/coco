/** Limites partilhados entre frontend e servidor (sem dependências, para não arrastar zod para o bundle). */
export const LIMITS = {
  /** Caracteres máximos numa mensagem do utilizador. */
  messageChars: 32_000,
  /** Mensagens máximas enviadas como histórico num pedido. */
  historyMessages: 200,
  /** Anexos por mensagem. */
  attachmentsPerMessage: 5,
  /** Bytes máximos por anexo de texto lido no navegador. */
  attachmentBytes: 256 * 1024,
  /** Bytes máximos do corpo de um pedido HTTP. */
  requestBodyBytes: 2 * 1024 * 1024,
} as const;
