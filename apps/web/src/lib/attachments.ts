import { IMAGE_TYPES, LIMITS } from '../../../../shared/limits.ts';

/**
 * Pré-validação de anexos no navegador. É apenas UX: o servidor classifica
 * o ficheiro pelos bytes e decide (ver server/storage/sniff.ts).
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

export function isImageOrPdf(file: FileLike): boolean {
  const ext = extensionOf(file.name);
  return (
    (IMAGE_TYPES as readonly string[]).includes(file.type) ||
    file.type === 'application/pdf' ||
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'].includes(ext)
  );
}

export function validateAttachment(file: FileLike, alreadyAttached: number): AttachmentRejection | null {
  if (alreadyAttached >= LIMITS.attachmentsPerMessage) return 'too-many';
  if (file.size === 0) return 'empty';
  if (isImageOrPdf(file)) return file.size > LIMITS.binaryFileBytes ? 'too-large' : null;
  if (!isTextLike(file)) return 'unsupported-type';
  if (file.size > LIMITS.textFileBytes) return 'too-large';
  return null;
}

export function rejectionMessage(reason: AttachmentRejection): string {
  switch (reason) {
    case 'too-many':
      return `Máximo de ${LIMITS.attachmentsPerMessage} anexos por mensagem.`;
    case 'too-large':
      return `Demasiado grande (texto até ${formatBytes(LIMITS.textFileBytes)}, imagens e PDF até ${formatBytes(LIMITS.binaryFileBytes)}).`;
    case 'unsupported-type':
      return 'Tipo não suportado. Aceites: texto, PNG, JPEG, GIF, WebP e PDF.';
    case 'empty':
      return 'Ficheiro vazio.';
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}
