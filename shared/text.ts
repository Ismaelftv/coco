export const TITLE_MAX = 60;

/** Título de uma conversa a partir da primeira mensagem. */
export function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0]?.replace(/\s+/g, ' ') ?? '';
  if (!firstLine) return 'Nova conversa';
  return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1).trimEnd()}…` : firstLine;
}
