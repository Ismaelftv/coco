import { LIMITS } from '../../../../shared/limits.ts';

/**
 * Validação de anexos no navegador. É uma verificação de UX — o servidor
 * volta a validar tudo. Nesta fase só são aceites ficheiros de texto, lidos
 * localmente e enviados no corpo do pedido. Upload de binários/imagens para
 * armazenamento de objetos fica para a Fase 3.
 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'xml',
  'html', 'css', 'scss', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java',
  'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'graphql',
  'proto', 'env.example', 'gitignore', 'dockerfile', 'log',
]);

export type AttachmentRejection = 'too-many' | 'too-large' | 'unsupported-type' | 'empty';

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

export function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  const dot = lower.lastIndexOf('.');
  return dot === -1 ? '' : lower.slice(dot + 1);
}

export function isTextLike(file: FileLike): boolean {
  if (file.type.startsWith('text/')) return true;
  if (/^application\/(json|xml|x-yaml|yaml|toml|x-sh|javascript|typescript|sql)/.test(file.type)) return true;
  return TEXT_EXTENSIONS.has(extensionOf(file.name));
}

export function validateAttachment(file: FileLike, alreadyAttached: number): AttachmentRejection | null {
  if (alreadyAttached >= LIMITS.attachmentsPerMessage) return 'too-many';
  if (file.size === 0) return 'empty';
  if (file.size > LIMITS.attachmentBytes) return 'too-large';
  if (!isTextLike(file)) return 'unsupported-type';
  return null;
}

export function rejectionMessage(reason: AttachmentRejection): string {
  switch (reason) {
    case 'too-many':
      return `Máximo de ${LIMITS.attachmentsPerMessage} anexos por mensagem.`;
    case 'too-large':
      return `Excede ${formatBytes(LIMITS.attachmentBytes)}.`;
    case 'unsupported-type':
      return 'Só ficheiros de texto nesta fase. Imagens e binários: pendente (Fase 3).';
    case 'empty':
      return 'Ficheiro vazio.';
  }
}

/** Heurística: presença de byte NUL indica conteúdo binário. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes('\u0000');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}
