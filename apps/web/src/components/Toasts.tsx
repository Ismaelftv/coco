import type { Notice } from '../features/chat/useChat.ts';
import { Icon } from './Icon.tsx';

/** Avisos transitórios (ex.: falha ao eliminar). Anunciados a leitores de ecrã. */
export function Toasts({ notices, onDismiss }: { notices: Notice[]; onDismiss(id: number): void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className="toast">
          <span>{n.message}</span>
          <button type="button" className="icon-btn icon-btn--sm" onClick={() => onDismiss(n.id)} aria-label="Fechar aviso">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
