import { useCallback, useEffect, useMemo, useState } from 'react';
import { Composer } from '../components/Composer.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { Icon } from '../components/Icon.tsx';
import { MessageList } from '../components/MessageList.tsx';
import { Sidebar } from '../components/Sidebar.tsx';
import type { ConversationRepository } from '../features/chat/repository.ts';
import { sortedConversations } from '../features/chat/store.ts';
import { useChat } from '../features/chat/useChat.ts';
import { useTheme } from '../features/theme/useTheme.ts';
import { useMediaQuery } from '../lib/useMediaQuery.ts';

const SIDEBAR_ID = 'app-sidebar';

export function App({ repository }: { repository: ConversationRepository }) {
  const chat = useChat(repository);
  const { theme, setTheme } = useTheme();
  const compact = useMediaQuery('(max-width: 899px)');
  const [desktopOpen, setDesktopOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebarVisible = compact ? drawerOpen : desktopOpen;

  const conversations = useMemo(() => sortedConversations(chat.state), [chat.state]);
  const active = chat.active;

  useEffect(() => {
    if (!compact) setDrawerOpen(false);
  }, [compact]);

  // Gaveta móvel: Escape fecha; o foco entra na gaveta ao abrir e volta ao botão ao fechar.
  useEffect(() => {
    if (!compact || !drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    document.querySelector<HTMLElement>(`#${SIDEBAR_ID} button`)?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-drawer-toggle]')?.focus());
    };
  }, [compact, drawerOpen]);

  useEffect(() => {
    document.title = active ? `${active.title} · Forja` : 'Forja';
  }, [active?.title]);

  const toggleSidebar = useCallback(() => {
    if (compact) setDrawerOpen((o) => !o);
    else setDesktopOpen((o) => !o);
  }, [compact]);

  const afterNavigate = useCallback(() => {
    if (compact) setDrawerOpen(false);
  }, [compact]);

  const generatingId = chat.state.generation?.conversationId ?? null;

  return (
    <div className="app" data-sidebar={sidebarVisible ? 'open' : 'closed'} data-compact={compact}>
      <a className="skip-link" href="#composer-input">
        Saltar para a caixa de mensagem
      </a>

      {sidebarVisible ? (
        <Sidebar
          id={SIDEBAR_ID}
          conversations={conversations}
          activeId={chat.state.activeId}
          generatingId={generatingId}
          isGenerating={chat.isGenerating}
          theme={theme}
          onTheme={setTheme}
          onNew={() => {
            chat.newConversation();
            afterNavigate();
          }}
          onSelect={(id) => {
            chat.select(id);
            afterNavigate();
          }}
          onRename={chat.rename}
          onDelete={chat.remove}
          onCollapse={toggleSidebar}
          collapseLabel={compact ? 'Fechar menu' : 'Recolher barra lateral'}
          collapseIcon={compact ? 'close' : 'sidebar'}
        />
      ) : null}
      {compact && drawerOpen ? <div className="scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" /> : null}

      <main className="main" inert={compact && drawerOpen ? true : undefined}>
        <header className="topbar">
          {!sidebarVisible ? (
            <button
              type="button"
              className="icon-btn"
              onClick={toggleSidebar}
              aria-label={compact ? 'Abrir menu' : 'Expandir barra lateral'}
              aria-controls={SIDEBAR_ID}
              aria-expanded={false}
              data-drawer-toggle
            >
              <Icon name={compact ? 'menu' : 'sidebar'} />
            </button>
          ) : null}
          {!sidebarVisible ? (
            <button
              type="button"
              className="icon-btn"
              onClick={chat.newConversation}
              disabled={chat.isGenerating}
              aria-label="Nova conversa"
              title="Nova conversa"
            >
              <Icon name="plus" />
            </button>
          ) : null}
          <h1 className="topbar__title">{active?.title ?? 'Nova conversa'}</h1>
          <span className="badge badge--simulated topbar__badge" title="Nenhum modelo de IA está ligado.">
            Modo simulado
          </span>
        </header>

        {active && active.messages.length > 0 ? (
          <MessageList
            conversationId={active.id}
            messages={active.messages}
            isGenerating={chat.isGenerating}
            onRegenerate={chat.regenerate}
          />
        ) : (
          <div className="thread thread--empty">
            <EmptyState
              disabled={chat.isGenerating || !chat.selectedModel}
              onPick={(prompt) => chat.send(prompt)}
            />
          </div>
        )}

        <Composer
          isGenerating={chat.isGenerating}
          canSend={chat.selectedModel !== null && !chat.isGenerating}
          models={chat.models}
          selectedModel={chat.selectedModel}
          onSelectModel={chat.chooseModel}
          onRetryModels={chat.reloadModels}
          onSend={chat.send}
          onStop={chat.stop}
          autoFocusKey={chat.state.activeId ?? 'new'}
        />
      </main>
    </div>
  );
}
