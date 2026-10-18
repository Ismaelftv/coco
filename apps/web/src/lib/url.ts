const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Devolve o URL se o protocolo for seguro para uma ligação gerada pelo modelo,
 * ou null (o texto é mostrado sem ligação). Bloqueia javascript:, data:, vbscript:,
 * file: e URLs relativos ambíguos.
 */
export function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Remove caracteres de controlo usados para ofuscar esquemas (ex.: "java\tscript:").
  const cleaned = trimmed.replace(/[\u0000-\u001F\u007F\s]+/g, '');
  try {
    const url = new URL(cleaned);
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
