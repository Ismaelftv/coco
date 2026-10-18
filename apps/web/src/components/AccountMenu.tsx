import { useEffect, useRef, useState } from 'react';
import type { User } from '../../../../shared/contract.ts';
import { Icon } from './Icon.tsx';

export function AccountMenu({ user, onLogout }: { user: User; onLogout(): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const label = user.displayName ?? user.email;
  const initial = label.trim().charAt(0).toUpperCase() || '?';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="account" ref={root}>
      <button
        type="button"
        className="account__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Conta: ${user.email}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="account__name">{label}</span>
      </button>
      {open ? (
        <div className="popover account__menu" role="menu">
          <p className="account__email">{user.email}</p>
          <span className="menu-item menu-item--disabled" role="menuitem" aria-disabled="true">
            <Icon name="settings" size={16} /> Definições
            <span className="badge badge--pending">Pendente</span>
          </span>
          <button type="button" role="menuitem" className="menu-item" autoFocus onClick={onLogout}>
            <Icon name="logout" size={16} /> Terminar sessão
          </button>
        </div>
      ) : null}
    </div>
  );
}
