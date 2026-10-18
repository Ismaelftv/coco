import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../features/chat/types.ts';
import { groupByDate } from '../lib/time.ts';
import { Icon } from './Icon.tsx';

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  generatingId: string | null;
  query: string;
  onSelect(id: string): void;
  onRename(id: string, title: string): void;
  onDelete(id: string): void;
}

export function ConversationList({ conversations, activeId, generatingId, query, onSelect, onRename, onDelete }: Props) {
  if (conversations.length === 0) {
    return (
      <p className="sidebar__empty">
        {query ? `Nada encontrado para “${query}”.` : 'Ainda não tens conversas. Começa uma nova acima.'}
      </p>
    );
  }
  const groups = groupByDate(conversations, (c) => c.updatedAt);
  return (
    <nav aria-label="Histórico de conversas" className="history">
      {groups.map(({ group, items }) => (
        <section key={group} className="history__group" aria-label={group}>
          <h2 className="history__label">{group}</h2>
          <ul className="history__list">
            {items.map((c) => (
              <ConversationItem
                key={c.id}
                conversation={c}
                active={c.id === activeId}
                generating={c.id === generatingId}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

type Mode = 'idle' | 'menu' | 'rename' | 'confirm-delete';

function ConversationItem({
  conversation,
  active,
  generating,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: Conversation;
  active: boolean;
  generating: boolean;
  onSelect(id: string): void;
  onRename(id: string, title: string): void;
  onDelete(id: string): void;
}) {
  const [mode, setMode] = useState<Mode>('idle');
  const [draft, setDraft] = useState(conversation.title);
  const input = useRef<HTMLInputElement | null>(null);
  const root = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (mode === 'rename') input.current?.select();
  }, [mode]);

  useEffect(() => {
    if (mode !== 'menu' && mode !== 'confirm-delete') return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setMode('idle');
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [mode]);

  if (mode === 'rename') {
    const commit = () => {
      onRename(conversation.id, draft);
      setMode('idle');
    };
    return (
      <li className="history__item is-editing" ref={root}>
        <input
          ref={input}
          className="history__rename"
          value={draft}
          maxLength={120}
          aria-label="Novo título"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(conversation.title);
              setMode('idle');
            }
          }}
        />
      </li>
    );
  }

  return (
    <li className={active ? 'history__item is-active' : 'history__item'} ref={root}>
      <button
        type="button"
        className="history__link"
        aria-current={active ? 'page' : undefined}
        onClick={() => onSelect(conversation.id)}
      >
        <span className="history__title">{conversation.title}</span>
        {generating ? <span className="history__live" aria-label="A gerar" /> : null}
      </button>
      <button
        type="button"
        className="history__more icon-btn icon-btn--sm"
        aria-label={`Opções de “${conversation.title}”`}
        aria-haspopup="menu"
        aria-expanded={mode === 'menu'}
        onClick={() => setMode(mode === 'menu' ? 'idle' : 'menu')}
      >
        <Icon name="more" size={16} />
      </button>

      {mode === 'menu' ? (
        <div className="popover history__menu" role="menu" onKeyDown={(e) => e.key === 'Escape' && setMode('idle')}>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            autoFocus
            onClick={() => {
              setDraft(conversation.title);
              setMode('rename');
            }}
          >
            <Icon name="edit" size={16} /> Mudar o nome
          </button>
          <button type="button" role="menuitem" className="menu-item menu-item--danger" onClick={() => setMode('confirm-delete')}>
            <Icon name="trash" size={16} /> Eliminar
          </button>
        </div>
      ) : null}

      {mode === 'confirm-delete' ? (
        <div className="popover history__menu" role="alertdialog" aria-label="Confirmar eliminação">
          <p className="history__confirm">Eliminar esta conversa? Não é possível anular.</p>
          <div className="history__confirm-actions">
            <button type="button" className="btn btn--ghost btn--sm" autoFocus onClick={() => setMode('idle')}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              onClick={() => {
                setMode('idle');
                onDelete(conversation.id);
              }}
            >
              Eliminar
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
