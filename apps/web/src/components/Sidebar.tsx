import { useEffect, useState } from 'react';
import type { User } from '../../../../shared/contract.ts';
import type { Conversation } from '../features/chat/types.ts';
import type { ListState } from '../features/chat/useChat.ts';
import type { ThemePreference } from '../features/theme/useTheme.ts';
import { AccountMenu } from './AccountMenu.tsx';
import { ConversationList } from './ConversationList.tsx';
import { Icon, Logo, type IconName } from './Icon.tsx';

export interface LegacyOffer {
  count: number;
  busy: boolean;
  onImport(): void;
  onDiscard(): void;
}

interface Props {
  id: string;
  user: User;
  conversations: Conversation[];
  list: ListState;
  activeId: string | null;
  generatingId: string | null;
  isGenerating: boolean;
  theme: ThemePreference;
  legacy: LegacyOffer | null;
  onTheme(theme: ThemePreference): void;
  onNew(): void;
  onSelect(id: string): void;
  onRename(id: string, title: string): void;
  onDelete(id: string): void;
  onLoadMore(): void;
  onRetryList(): void;
  onLogout(): void;
  search(q: string, signal: AbortSignal): Promise<Conversation[]>;
  onCollapse(): void;
  collapseLabel: string;
  collapseIcon: IconName;
}

type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; results: Conversation[] };

const THEMES: { value: ThemePreference; label: string; icon: IconName }[] = [
  { value: 'system', label: 'Sistema', icon: 'monitor' },
  { value: 'light', label: 'Claro', icon: 'sun' },
  { value: 'dark', label: 'Escuro', icon: 'moon' },
];

export function Sidebar(props: Props) {
  const [query, setQuery] = useState('');
  const [searchState, setSearchState] = useState<SearchState>({ status: 'idle' });
  const q = query.trim();

  // Pesquisa no servidor (título e conteúdo), com atraso para não pedir a cada tecla.
  useEffect(() => {
    if (!q) {
      setSearchState({ status: 'idle' });
      return;
    }
    setSearchState({ status: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      props
        .search(q, controller.signal)
        .then((results) => setSearchState({ status: 'done', results }))
        .catch((err: Error) => {
          if (err.name !== 'AbortError') setSearchState({ status: 'error', message: err.message });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- search é estável
  }, [q]);

  // Reflete renomeações/eliminações locais nos resultados da pesquisa.
  const searchResults =
    searchState.status === 'done'
      ? searchState.results
          .filter((r) => props.conversations.some((c) => c.id === r.id))
          .map((r) => props.conversations.find((c) => c.id === r.id) ?? r)
      : [];

  return (
    <aside id={props.id} className="sidebar" aria-label="Barra lateral">
      <div className="sidebar__header">
        <div className="brand">
          <Logo />
          <span className="brand__name">Forja</span>
        </div>
        <button type="button" className="icon-btn" onClick={props.onCollapse} aria-label={props.collapseLabel} title={props.collapseLabel}>
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

      {props.legacy ? (
        <div className="import-offer" role="region" aria-label="Importar histórico">
          <p>
            Há <strong>{props.legacy.count}</strong> {props.legacy.count === 1 ? 'conversa guardada' : 'conversas guardadas'} neste
            navegador pela versão anterior.
          </p>
          <div className="import-offer__actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={props.legacy.onImport} disabled={props.legacy.busy}>
              {props.legacy.busy ? 'A importar…' : 'Importar'}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={props.legacy.onDiscard} disabled={props.legacy.busy}>
              Descartar
            </button>
          </div>
        </div>
      ) : null}

      <div className="sidebar__section">
        <div className="sidebar__row sidebar__row--disabled" aria-disabled="true">
          <Icon name="folder" size={16} />
          <span>Projetos</span>
          <span className="badge badge--pending">Pendente</span>
        </div>
      </div>

      <div className="sidebar__scroll">
        {q ? (
          searchState.status === 'loading' ? (
            <p className="sidebar__empty" role="status">A pesquisar…</p>
          ) : searchState.status === 'error' ? (
            <p className="sidebar__empty sidebar__empty--error" role="alert">Pesquisa falhou: {searchState.message}</p>
          ) : (
            <ConversationList
              conversations={searchResults}
              activeId={props.activeId}
              generatingId={props.generatingId}
              query={q}
              onSelect={props.onSelect}
              onRename={props.onRename}
              onDelete={props.onDelete}
            />
          )
        ) : props.list.status === 'loading' ? (
          <div className="history-skeleton" role="status" aria-label="A carregar conversas">
            {[70, 55, 80, 60].map((w) => (
              <span key={w} className="skeleton history-skeleton__row" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : props.list.status === 'error' ? (
          <div className="sidebar__empty sidebar__empty--error" role="alert">
            <p>Não foi possível carregar o histórico.</p>
            <button type="button" className="btn btn--secondary btn--sm" onClick={props.onRetryList}>
              Tentar de novo
            </button>
          </div>
        ) : (
          <>
            <ConversationList
              conversations={props.conversations}
              activeId={props.activeId}
              generatingId={props.generatingId}
              query=""
              onSelect={props.onSelect}
              onRename={props.onRename}
              onDelete={props.onDelete}
            />
            {props.list.nextCursor ? (
              <button type="button" className="btn btn--ghost btn--sm btn--block load-more" onClick={props.onLoadMore}>
                Carregar mais
              </button>
            ) : null}
          </>
        )}
      </div>

      <div className="sidebar__footer">
        <AccountMenu user={props.user} onLogout={props.onLogout} />
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
