import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { FileInfo, ModelInfo } from '../../../../../shared/contract.ts';
import { api, HttpError } from '../../lib/api.ts';
import { streamChat, type SendBody } from './api.ts';
import { chatReducer, initialChatState } from './store.ts';
import { fromDetail, fromSummary, type Conversation } from './types.ts';

export type ModelsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; models: ModelInfo[] };

export type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; nextCursor: string | null };

export interface Notice {
  id: number;
  message: string;
}

const newId = () => crypto.randomUUID();

export function useChat() {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [models, setModels] = useState<ModelsState>({ status: 'loading' });
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [preferredModel, setPreferredModel] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const pendingDelta = useRef('');
  const frame = useRef<number | null>(null);
  /** Conversas que já existem no servidor (criação é idempotente). */
  const persisted = useRef(new Set<string>());

  const notify = useCallback((message: string) => {
    const id = Date.now() + Math.random();
    setNotices((n) => [...n.slice(-2), { id, message }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 6000);
  }, []);
  const dismissNotice = useCallback((id: number) => setNotices((n) => n.filter((x) => x.id !== id)), []);

  // ---- Modelos ----
  const loadModels = useCallback(() => {
    const controller = new AbortController();
    setModels({ status: 'loading' });
    api
      .models(controller.signal)
      .then(({ models: list }) => setModels({ status: 'ready', models: list }))
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setModels({ status: 'error', message: err.message });
      });
    return () => controller.abort();
  }, []);
  useEffect(() => loadModels(), [loadModels]);

  // ---- Lista de conversas ----
  const loadList = useCallback((cursor: string | null = null) => {
    const controller = new AbortController();
    if (!cursor) setList({ status: 'loading' });
    api
      .listConversations({ cursor }, controller.signal)
      .then(({ conversations, nextCursor }) => {
        for (const c of conversations) persisted.current.add(c.id);
        dispatch({ type: 'hydrate', conversations: conversations.map(fromSummary), append: cursor !== null });
        setList({ status: 'ready', nextCursor });
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setList({ status: 'error', message: err.message });
      });
    return () => controller.abort();
  }, []);
  useEffect(() => loadList(), [loadList]);

  const loadMore = useCallback(() => {
    if (list.status === 'ready' && list.nextCursor) loadList(list.nextCursor);
  }, [list, loadList]);

  const search = useCallback(async (q: string, signal: AbortSignal): Promise<Conversation[]> => {
    const { conversations } = await api.listConversations({ q }, signal);
    return conversations.map(fromSummary);
  }, []);

  // ---- Seleção e carregamento de uma conversa ----
  const fetchConversation = useCallback(async (id: string) => {
    setLoadErrors(({ [id]: _, ...rest }) => rest);
    try {
      const { conversation } = await api.getConversation(id);
      persisted.current.add(id);
      dispatch({ type: 'loaded', conversation: fromDetail(conversation) });
    } catch (err) {
      const e = err as HttpError;
      if (e.status === 404) {
        dispatch({ type: 'delete', id });
        notify('Esta conversa já não existe.');
      } else {
        setLoadErrors((m) => ({ ...m, [id]: e.message }));
      }
    }
  }, [notify]);

  const select = useCallback(
    (id: string) => {
      dispatch({ type: 'select', id });
      const c = stateRef.current.conversations[id];
      if (!c?.loaded) void fetchConversation(id);
    },
    [fetchConversation],
  );

  // ---- Modelo selecionado ----
  const usableModels = useMemo(
    () => (models.status === 'ready' ? models.models.filter((m) => m.status !== 'requires-integration') : []),
    [models],
  );
  const active = state.activeId ? state.conversations[state.activeId] ?? null : null;
  const selectedModel =
    active?.model && usableModels.some((m) => m.id === active.model)
      ? active.model
      : preferredModel && usableModels.some((m) => m.id === preferredModel)
        ? preferredModel
        : usableModels[0]?.id ?? null;

  // ---- Streaming ----
  const flushDelta = useCallback((conversationId: string, messageId: string) => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    if (pendingDelta.current) {
      dispatch({ type: 'appendDelta', conversationId, messageId, text: pendingDelta.current });
      pendingDelta.current = '';
    }
  }, []);

  const ensurePersisted = useCallback(async (id: string, model: string) => {
    if (persisted.current.has(id)) return;
    await api.createConversation(id, model);
    persisted.current.add(id);
  }, []);

  const run = useCallback(
    async (conversationId: string, assistantId: string, body: SendBody) => {
      const controller = new AbortController();
      abortRef.current = controller;
      pendingDelta.current = '';
      const flush = () => flushDelta(conversationId, assistantId);
      let started = false;
      const fail = (error: { code: string; message: string; retryable: boolean }) => {
        flush();
        dispatch({ type: 'fail', conversationId, messageId: assistantId, error, now: Date.now(), notPersisted: !started && body.mode === 'send' });
      };
      try {
        await ensurePersisted(conversationId, body.model);
        await streamChat(
          conversationId,
          body,
          {
            onStart() {
              started = true;
            },
            onDelta(text) {
              pendingDelta.current += text;
              if (frame.current === null) {
                frame.current = requestAnimationFrame(() => {
                  frame.current = null;
                  flush();
                });
              }
            },
            onEnd({ finishReason, usage }) {
              flush();
              dispatch({ type: 'finish', conversationId, messageId: assistantId, finishReason, usage, now: Date.now() });
            },
            onError: fail,
          },
          controller.signal,
        );
      } catch (err) {
        if (controller.signal.aborted) {
          flush();
          dispatch({ type: 'finish', conversationId, messageId: assistantId, finishReason: 'cancelled', now: Date.now() });
        } else if (err instanceof HttpError) {
          fail({ code: err.code, message: err.message, retryable: err.status === 0 || err.status >= 500 });
        } else {
          fail({ code: 'network', message: `Falha de rede: ${(err as Error).message}`, retryable: true });
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [flushDelta, ensurePersisted],
  );

  // ---- Ações ----
  const newConversation = useCallback(() => {
    if (stateRef.current.generation) return;
    dispatch({ type: 'select', id: null });
  }, []);

  const rename = useCallback(
    async (id: string, title: string) => {
      const before = stateRef.current.conversations[id];
      if (!before || !title.trim() || title.trim() === before.title) return;
      dispatch({ type: 'rename', id, title });
      try {
        await ensurePersisted(id, before.model);
        await api.updateConversation(id, { title: title.trim() });
      } catch (err) {
        dispatch({ type: 'rename', id, title: before.title });
        notify(`Não foi possível mudar o nome: ${(err as Error).message}`);
      }
    },
    [ensurePersisted, notify],
  );

  const remove = useCallback(
    async (id: string) => {
      const before = stateRef.current.conversations[id];
      if (!before) return;
      if (stateRef.current.generation?.conversationId === id) abortRef.current?.abort();
      dispatch({ type: 'delete', id });
      if (!persisted.current.has(id)) return;
      try {
        await api.deleteConversation(id);
        persisted.current.delete(id);
      } catch (err) {
        if ((err as HttpError).status === 404) return;
        dispatch({ type: 'restore', conversation: before });
        notify(`Não foi possível eliminar: ${(err as Error).message}`);
      }
    },
    [notify],
  );

  const chooseModel = useCallback((model: string) => {
    setPreferredModel(model);
    const id = stateRef.current.activeId;
    if (id) dispatch({ type: 'setModel', id, model });
  }, []);

  const send = useCallback(
    (content: string, files: FileInfo[] = []) => {
      const current = stateRef.current;
      if (current.generation || !selectedModel) return false;
      if (!content.trim() && files.length === 0) return false;

      let conversation: Conversation | undefined = current.activeId ? current.conversations[current.activeId] : undefined;
      if (conversation && !conversation.loaded) return false;
      if (!conversation) {
        const id = newId();
        dispatch({ type: 'create', id, model: selectedModel, now: Date.now() });
        conversation = { id, title: 'Nova conversa', createdAt: Date.now(), updatedAt: Date.now(), model: selectedModel, messages: [], loaded: true };
      }
      const userId = newId();
      const assistantId = newId();
      dispatch({
        type: 'sendUser',
        conversationId: conversation.id,
        message: { id: userId, content, files },
        assistantId,
        model: selectedModel,
        now: Date.now(),
      });
      void run(conversation.id, assistantId, {
        mode: 'send',
        model: selectedModel,
        userMessage: { id: userId, content, fileIds: files.map((f) => f.id) },
        assistantMessageId: assistantId,
      });
      return true;
    },
    [run, selectedModel],
  );

  /** Repete (após erro) ou regenera a última resposta do assistente. */
  const regenerate = useCallback(
    (messageId: string) => {
      const current = stateRef.current;
      const conversation = current.activeId ? current.conversations[current.activeId] : undefined;
      if (!conversation || current.generation || !selectedModel) return;
      const index = conversation.messages.findIndex((m) => m.id === messageId);
      const target = conversation.messages[index];
      const previous = conversation.messages[index - 1];
      if (!target || target.role !== 'assistant') return;
      const assistantId = newId();
      dispatch({ type: 'truncateFrom', conversationId: conversation.id, messageId, assistantId, model: selectedModel, now: Date.now() });
      // Se o servidor nunca recebeu o pedido, repetir é reenviar a mensagem do utilizador.
      const body: SendBody =
        target.notPersisted && previous?.role === 'user'
          ? {
              mode: 'send',
              model: selectedModel,
              userMessage: { id: previous.id, content: previous.content, fileIds: previous.files.map((f) => f.id) },
              assistantMessageId: assistantId,
            }
          : { mode: 'regenerate', model: selectedModel, fromMessageId: messageId, assistantMessageId: assistantId };
      void run(conversation.id, assistantId, body);
    },
    [run, selectedModel],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    state,
    active,
    activeLoadError: active ? loadErrors[active.id] ?? null : null,
    retryLoad: fetchConversation,
    models,
    reloadModels: loadModels,
    list,
    reloadList: loadList,
    loadMore,
    search,
    selectedModel,
    chooseModel,
    isGenerating: state.generation !== null,
    notices,
    dismissNotice,
    notify,
    newConversation,
    select,
    rename,
    remove,
    send,
    regenerate,
    stop,
  };
}

export type ChatController = ReturnType<typeof useChat>;
