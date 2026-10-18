/**
 * Classificação de ficheiros pelo conteúdo (bytes iniciais), não pelo nome
 * nem pelo Content-Type declarado pelo cliente. O tipo guardado e servido é
 * sempre o detetado aqui.
 */
import { LIMITS, IMAGE_TYPES } from '../../shared/limits.ts';
import type { FileKind } from '../../shared/contract.ts';

export interface Detected {
  kind: FileKind;
  mediaType: string;
}

const startsWith = (b: Buffer, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);

export function detectBinary(b: Buffer): Detected | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mediaType: 'image/png' };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { kind: 'image', mediaType: 'image/jpeg' };
  if (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a') {
    return { kind: 'image', mediaType: 'image/gif' };
  }
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { kind: 'image', mediaType: 'image/webp' };
  }
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', mediaType: 'application/pdf' };
  return null;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

export function isUtf8Text(b: Buffer): boolean {
  if (b.includes(0)) return false;
  try {
    decoder.decode(b);
    return true;
  } catch {
    return false;
  }
}

export type SniffResult = { ok: true; detected: Detected } | { ok: false; code: string; message: string };

export function classify(data: Buffer): SniffResult {
  if (data.length === 0) return { ok: false, code: 'empty_file', message: 'Ficheiro vazio.' };
  const binary = detectBinary(data);
  if (binary) {
    if (data.length > LIMITS.binaryFileBytes) {
      return { ok: false, code: 'file_too_large', message: 'Imagens e PDF até 10 MB.' };
    }
    if (binary.kind === 'image' && !(IMAGE_TYPES as readonly string[]).includes(binary.mediaType)) {
      return { ok: false, code: 'unsupported_type', message: 'Formato de imagem não suportado.' };
    }
    return { ok: true, detected: binary };
  }
  if (isUtf8Text(data)) {
    if (data.length > LIMITS.textFileBytes) {
      return { ok: false, code: 'file_too_large', message: 'Ficheiros de texto até 1 MB.' };
    }
    // Texto (incluindo SVG/HTML) é sempre servido como text/plain para download.
    return { ok: true, detected: { kind: 'text', mediaType: 'text/plain; charset=utf-8' } };
  }
  return {
    ok: false,
    code: 'unsupported_type',
    message: 'Tipo de ficheiro não suportado. Aceites: texto UTF-8, PNG, JPEG, GIF, WebP e PDF.',
  };
}

/** Normaliza o nome indicado pelo cliente (só para mostrar; nunca para caminhos). */
export function cleanFileName(raw: string | undefined): string {
  let name = '';
  try {
    name = decodeURIComponent(raw ?? '');
  } catch {
    name = raw ?? '';
  }
  name = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 255);
  return name || 'ficheiro';
}
