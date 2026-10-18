import type { Queryable } from '../db/db.ts';

export type AuditAction =
  | 'auth.signup'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'conversation.delete'
  | 'file.upload'
  | 'file.delete'
  | 'import.local';

/** Regista um evento. Nunca guarda palavras-passe, tokens ou conteúdo de mensagens. */
export async function audit(
  q: Queryable,
  entry: { userId: string | null; action: AuditAction; target?: string; ip?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await q.query('INSERT INTO audit_log (user_id, action, target, ip, metadata) VALUES ($1, $2, $3, $4, $5)', [
    entry.userId,
    entry.action,
    entry.target ?? null,
    entry.ip ?? null,
    entry.metadata ?? null,
  ]);
}
