/** Limites partilhados entre frontend e servidor (sem dependências, para não arrastar zod para o bundle). */
export const LIMITS = {
  /** Caracteres máximos numa mensagem do utilizador. */
  messageChars: 32_000,
  /** Anexos por mensagem. */
  attachmentsPerMessage: 5,
  /** Bytes máximos de um ficheiro de texto. */
  textFileBytes: 1024 * 1024,
  /** Bytes máximos de uma imagem ou PDF. */
  binaryFileBytes: 10 * 1024 * 1024,
  /** Quota total de ficheiros por utilizador. */
  userStorageBytes: 200 * 1024 * 1024,
  /** Caracteres de texto de um anexo incluídos no contexto do modelo. */
  attachmentContextChars: 256 * 1024,
  /** Bytes máximos de um corpo JSON normal. */
  jsonBodyBytes: 1024 * 1024,
  /** Bytes máximos do pedido de importação do histórico local. */
  importBodyBytes: 20 * 1024 * 1024,
  /** Comprimento de palavra-passe. */
  passwordMin: 10,
  passwordMax: 256,
  /** Conversas devolvidas por página na barra lateral. */
  conversationsPage: 100,
} as const;

/** Tipos de imagem aceites (conteúdo verificado pelos bytes iniciais no servidor). */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
