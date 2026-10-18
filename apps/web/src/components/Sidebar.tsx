import { useDeferredValue, useMemo, useState } from 'react';
import type { Conversation } from '../features/chat/types.ts';
import { searchConversations } from '../features/chat/store.ts';
import type { ThemePreference } from '../features/theme/useTheme.ts';
import { ConversationList } from './ConversationList.tsx';
import { Icon, Logo, type IconName } from './Icon.tsx';

interface Props {
  id: string;
  conversations: Conversation[];
  activeId: string | null;
  generatingId: string | null;
  isGenerating: boolean;
  theme: ThemePreference;
  onTheme(theme: ThemePreference): void;
  onNew(): void;
  onSelect(id: string): void;
  onRename(id: string, title: string): void;
  onDelete(id: string): void;
  onCollapse(): void;
  collapseLabel: string;
  collapseIcon: IconName;
}

const THEMES: { value: ThemePreference; label: string; icon: IconName }[] = [
  { value: 'system', label: 'Sistema', icon: 'monitor' },
  { value: 'light', label: 'Claro', icon: 'sun' },
  { value: 'dark', label: 'Escuro', icon: 'moon' },
];

export function Sidebar(props: Props) {
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const filtered = useMemo(() => searchConversations(props.conversations, deferred), [props.conversations, deferred]);

  return (
    <aside id={props.id} className="sidebar" aria-label="Barra lateral">
      <div className="sidebar__header">
        <div className="brand">
          <Logo />
          <span className="brand__name">Forja</span>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={props.onCollapse}
          aria-label={props.collapseLabel}
          title={props.collapseLabel}
        >
          <Icon name={props.collapseIcon} />
        </button>
      </div>

      <button type="button" className="btn btn--primary btn--block" onClick={props.onNew} disabled={props.isGenerating}>
        <Icon name="plus" size={16} />
        Nova conversa
      </button>

      <div className="search">
        <Icon name="search" size={16} className="search__icon" />
        <input
          type="search"
          className="search__input"
          placeholder="Pesquisar conversas"
          aria-label="Pesquisar conversas"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
        />
      </div>

      <div className="sidebar__section">
        <div className="sidebar__row sidebar__row--disabled" aria-disabled="true">
          <Icon name="folder" size={16} />
          <span>Projetos</span>
          <span className="badge badge--pending">Pendente</span>
        </div>
        <div className="sidebar__row sidebar__row--disabled" aria-disabled="true">
          <Icon name="settings" size={16} />
          <span>Definições</span>
          <span className="badge badge--pending">Pendente</span>
        </div>
      </div>

      <div className="sidebar__scroll">
        <ConversationList
          conversations={filtered}
          activeId={props.activeId}
          generatingId={props.generatingId}
          query={deferred.trim()}
          onSelect={props.onSelect}
          onRename={props.onRename}
          onDelete={props.onDelete}
        />
      </div>

      <div className="sidebar__footer">
        <span className="sidebar__footer-label" aria-hidden="true">
          Tema
        </span>
        <div className="segmented" role="radiogroup" aria-label="Tema">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={props.theme === t.value}
              className="segmented__item"
              onClick={() => props.onTheme(t.value)}
              title={t.label}
            >
              <Icon name={t.icon} size={15} />
              <span className="sr-only">{t.label}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
