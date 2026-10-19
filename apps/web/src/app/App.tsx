import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ModelInfo, User } from '../../../../shared/contract.ts';
import { Composer } from '../components/Composer.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { Icon, Logo } from '../components/Icon.tsx';
import { MessageList } from '../components/MessageList.tsx';
import { modelBadge } from '../components/ModelPicker.tsx';
import { Sidebar, type LegacyOffer } from '../components/Sidebar.tsx';
import { Toasts } from '../components/Toasts.tsx';
import { AuthScreen } from '../features/auth/AuthScreen.tsx';
import { useAuth } from '../features/auth/useAuth.ts';
import { browserStorage, clearLegacy, readLegacy } from '../features/chat/legacy.ts';
import { sortedConversations } from '../features/chat/store.ts';
import { useChat } from '../features/chat/useChat.ts';
import { useTheme } from '../features/theme/useTheme.ts';
import { api } from '../lib/api.ts';
import { useMediaQuery } from '../lib/useMediaQuery.ts';

const SIDEBAR_ID = 'app-sidebar';

/** Raiz: decide entre verificação de sessão, ecrã de entrada e aplicação. */
export function Root() {
  const auth = useAuth();
  const s = auth.state;
  if (s.status === 'checking') {
    return (
      <div className="splash" role="status" aria-label="A carregar">
        <Logo size={44} />
      </div>
    );
  }
  if (s.status === 'offline') {
    return (
      <div className="splash">
        <div className="splash__card" role="alert">
          <Icon name="alert" size={22} />
          <p>Não foi possível contactar o servidor.</p>
          <p className="splash__detail">{s.message}</p>
          <button type="button" className="btn btn--primary" onClick={() => void auth.check()}>
            Tentar de novo
          </button>
        </div>
      </div>
    );
  }
  if (s.status === 'signed-out') {
    return <AuthScreen signupEnabled={s.signupEnabled} expired={s.expired} onLogin={auth.login} onSignup={auth.signup} />;
  }
  // A key garante estado limpo ao trocar de conta no mesmo separador.
  return <ChatApp key={s.user.id} user={s.user} onLogout={auth.logout} />;
}

function ChatApp({ user, onLogout }: { user: User; onLogout(): Promise<void> }) {
  const chat = useChat();
  const { theme, setTheme } = useTheme();
  const compact = useMediaQuery('(max-width: 899px)');
  const [desktopOpen, setDesktopOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebarVisible = compact ? drawerOpen : desktopOpen;

  const conversations = useMemo(() => sortedConversations(chat.state), [chat.state]);
  const active = chat.active;

  // ---- Importação do histórico da Fase 2 ----
  const [legacyCount, setLegacyCount] = useState(() => readLegacy(browserStorage()).length);
  const [importing, setImporting] = useState(false);
  const { reloadList, notify } = chat;
  const legacy: LegacyOffer | null = useMemo(
    () =>
      legacyCount > 0
        ? {
            count: legacyCount,
            busy: importing,
            onImport: async () => {
              setImporting(true);
              try {
                const { imported } = await api.importLocal({ conversations: readLegacy(browserStorage()) });
                clearLegacy(browserStorage());
                setLegacyCount(0);
                reloadList();
                notify(`Importadas ${imported.conversations} conversas e ${imported.files} anexos.`);
              } catch (err) {
                notify(`A importação falhou: ${(err as Error).message}`);
              } finally {
                setImporting(false);
              }
            },
            onDiscard: () => {
              clearLegacy(browserStorage());
              setLegacyCount(0);
            },
          }
        : null,
    [legacyCount, importing, reloadList, notify],
  );

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
  const selectedInfo = chat.models.status === 'ready' ? chat.models.models.find((m) => m.id === chat.selectedModel) : undefined;
  const modelNote = describeModel(selectedInfo);

  let thread;
  if (active && !active.loaded) {
    thread = chat.activeLoadError ? (
      <div className="thread thread--empty">
        <div className="callout callout--danger" role="alert">
          <Icon name="alert" size={18} />
          <div className="callout__body">
            <p className="callout__title">Não foi possível abrir a conversa.</p>
            <p className="callout__text">{chat.activeLoadError}</p>
          </div>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void chat.retryLoad(active.id)}>
            Tentar de novo
          </button>
        </div>
      </div>
    ) : (
      <div className="thread thread--empty" role="status" aria-label="A carregar conversa">
        <div className="thread-skeleton">
          <span className="skeleton thread-skeleton__user" />
          <span className="skeleton thread-skeleton__line" />
          <span className="skeleton thread-skeleton__line thread-skeleton__line--short" />
        </div>
      </div>
    );
  } else if (active && active.messages.length > 0) {
    thread = (
      <MessageList conversationId={active.id} messages={active.messages} isGenerating={chat.isGenerating} onRegenerate={chat.regenerate} />
    );
  } else {
    thread = (
      <div className="thread thread--empty">
        <EmptyState
          disabled={chat.isGenerating || !chat.selectedModel}
          simulated={!selectedInfo || selectedInfo.hosting === 'simulated'}
          onPick={(prompt) => chat.send(prompt)}
        />
      </div>
    );
  }

  return (
    <div className="app" data-sidebar={sidebarVisible ? 'open' : 'closed'} data-compact={compact}>
      <a className="skip-link" href="#composer-input">
        Saltar para a caixa de mensagem
      </a>

      {sidebarVisible ? (
        <Sidebar
          id={SIDEBAR_ID}
          user={user}
          conversations={conversations}
          list={chat.list}
          activeId={chat.state.activeId}
          generatingId={generatingId}
          isGenerating={chat.isGenerating}
          theme={theme}
          legacy={legacy}
          onTheme={setTheme}
          onNew={() => {
            chat.newConversation();
            afterNavigate();
          }}
          onSelect={(id) => {
            chat.select(id);
            afterNavigate();
          }}
          onRename={(id, title) => void chat.rename(id, title)}
          onDelete={(id) => void chat.remove(id)}
          onLoadMore={chat.loadMore}
          onRetryList={() => chat.reloadList()}
          onLogout={() => void onLogout()}
          search={chat.search}
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
          {selectedInfo ? (
            <span className={`badge badge--${modelBadge(selectedInfo).tone} topbar__badge`} title={modelNote}>
              {selectedInfo.hosting === 'simulated' ? 'Modo simulado' : selectedInfo.hosting === 'self-hosted' ? 'Modelo local' : 'Serviço externo'}
            </span>
          ) : null}
        </header>

        {thread}

        <Composer
          isGenerating={chat.isGenerating}
          canSend={chat.selectedModel !== null && !chat.isGenerating && (!active || active.loaded)}
          models={chat.models}
          selectedModel={chat.selectedModel}
          onSelectModel={chat.chooseModel}
          onRetryModels={chat.reloadModels}
          onSend={chat.send}
          imagesAvailable={chat.capabilities.images.available}
          imageNote={chat.capabilities.images.available ? chat.capabilities.images.label : ''}
          creatingImage={chat.creatingImage}
          onCreateImage={chat.createImage}
          onStop={chat.stop}
          autoFocusKey={chat.state.activeId ?? 'new'}
          modelNote={modelNote}
        />
      </main>
      <Toasts notices={chat.notices} onDismiss={chat.dismissNotice} />
    </div>
  );
}

/** Frase honesta sobre quem está a gerar as respostas. */
function describeModel(m: ModelInfo | undefined): string {
  if (!m) return 'Nenhum modelo disponível.';
  if (m.hosting === 'simulated') return 'Fornecedor simulado: as respostas não vêm de um modelo de IA.';
  const by = [m.author, m.license].filter(Boolean).join(', ');
  const where = m.hosting === 'self-hosted' ? 'a correr na infraestrutura da Forja' : 'serviço externo';
  return `Respostas de ${m.label}${by ? ` (${by})` : ''}, ${where}. Os modelos podem errar: verifica informação importante.`;
}
