import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ChatMessage, ModelInfo } from '../../../../../shared/contract.ts';
import { fetchModels, streamChat } from './api.ts';
import type { ConversationRepository } from './repository.ts';
import { chatReducer, initialChatState, type ChatState } from './store.ts';
import type { Conversation, Message, MessageAttachment } from './types.ts';

export type ModelsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; models: ModelInfo[] };

const newId = () => crypto.randomUUID();

/** Converte o histórico local no formato do contrato, omitindo respostas falhadas ou vazias. */
export function toRequestMessages(messages: readonly Message[]): ChatMessage[] {
  return messages
    .filter((m) => m.role === 'user' || (m.status !== 'error' && m.content.length > 0))
    .map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.attachments?.length
        ? { attachments: m.attachments.map(({ name, mediaType, content }) => ({ name, mediaType, content })) }
        : {}),
    }));
}

export function useChat(repository: ConversationRepository) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState, (s: ChatState) => ({
    ...s,
    conversations: Object.fromEntries(repository.load().map((c) => [c.id, c])),
  }));
  const stateRef = useRef(state);
  stateRef.current = state;

  const [models, setModels] = useState<ModelsState>({ status: 'loading' });
  const [preferredModel, setPreferredModel] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const pendingDelta = useRef('');
  const frame = useRef<number | null>(null);

  // ---- Modelos ----
  const loadModels = useCallback(() => {
    const controller = new AbortController();
    setModels({ status: 'loading' });
    fetchModels(controller.signal)
      .then((list) => setModels({ status: 'ready', models: list }))
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setModels({ status: 'error', message: err.message });
      });
    return () => controller.abort();
  }, []);
  useEffect(() => loadModels(), [loadModels]);

  const usableModels = useMemo(
    () => (models.status === 'ready' ? models.models.filter((m) => m.status !== 'requires-integration') : []),
    [models],
  );
  const active = state.activeId ? state.conversations[state.activeId] ?? null : null;
  const selectedModel =
    active?.model && usableModels.some((m) => m.id === active.model)
      ? active.model
      : preferredModel ?? usableModels[0]?.id ?? null;

  // ---- Persistência ----
  // Grava em cada alteração discreta; durante o streaming não grava a cada
  // fragmento, mas grava ao sair da página para não perder texto parcial.
  useEffect(() => {
    if (state.generation) return;
    repository.save(Object.values(state.conversations));
  }, [state.conversations, state.generation, repository]);

  useEffect(() => {
    const onHide = () => repository.save(Object.values(stateRef.current.conversations));
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [repository]);

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

  const run = useCallback(
    async (conversationId: string, assistantId: string, model: string, history: ChatMessage[]) => {
      const controller = new AbortController();
      abortRef.current = controller;
      pendingDelta.current = '';
      const flush = () => flushDelta(conversationId, assistantId);
      try {
        await streamChat(
          { conversationId, model, messages: history },
          {
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
            onError(error) {
              flush();
              dispatch({ type: 'fail', conversationId, messageId: assistantId, error, now: Date.now() });
            },
          },
          controller.signal,
        );
      } catch (err) {
        flush();
        if (controller.signal.aborted) {
          dispatch({ type: 'finish', conversationId, messageId: assistantId, finishReason: 'cancelled', now: Date.now() });
        } else {
          dispatch({
            type: 'fail',
            conversationId,
            messageId: assistantId,
            error: { code: 'network', message: `Falha de rede: ${(err as Error).message}`, retryable: true },
            now: Date.now(),
          });
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [flushDelta],
  );

  // ---- Ações ----
  const newConversation = useCallback(() => {
    if (stateRef.current.generation) return;
    dispatch({ type: 'select', id: null });
  }, []);

  const select = useCallback((id: string) => dispatch({ type: 'select', id }), []);
  const rename = useCallback((id: string, title: string) => dispatch({ type: 'rename', id, title }), []);
  const remove = useCallback((id: string) => {
    if (stateRef.current.generation?.conversationId === id) abortRef.current?.abort();
    dispatch({ type: 'delete', id });
  }, []);

  const chooseModel = useCallback((model: string) => {
    setPreferredModel(model);
    const id = stateRef.current.activeId;
    if (id) dispatch({ type: 'setModel', id, model });
  }, []);

  const send = useCallback(
    (content: string, attachments: MessageAttachment[] = []) => {
      const current = stateRef.current;
      if (current.generation || !selectedModel) return false;
      if (!content.trim() && attachments.length === 0) return false;

      let conversation: Conversation | undefined = current.activeId
        ? current.conversations[current.activeId]
        : undefined;
      if (!conversation) {
        const id = newId();
        const now = Date.now();
        dispatch({ type: 'create', id, model: selectedModel, now });
        conversation = { id, title: 'Nova conversa', createdAt: now, updatedAt: now, model: selectedModel, messages: [] };
      }
      const userMessage: Message = {
        id: newId(),
        role: 'user',
        content,
        createdAt: Date.now(),
        status: 'complete',
        ...(attachments.length ? { attachments } : {}),
      };
      const assistantId = newId();
      const history = toRequestMessages([...conversation.messages, userMessage]);
      dispatch({
        type: 'sendUser',
        conversationId: conversation.id,
        message: { id: userMessage.id, content, ...(attachments.length ? { attachments } : {}) },
        assistantId,
        model: selectedModel,
        now: Date.now(),
      });
      void run(conversation.id, assistantId, selectedModel, history);
      return true;
    },
    [run, selectedModel],
  );

  /** Repete (após erro) ou regenera uma resposta do assistente. */
  const regenerate = useCallback(
    (messageId: string) => {
      const current = stateRef.current;
      const conversation = current.activeId ? current.conversations[current.activeId] : undefined;
      if (!conversation || current.generation || !selectedModel) return;
      const index = conversation.messages.findIndex((m) => m.id === messageId);
      if (index <= 0) return;
      const history = toRequestMessages(conversation.messages.slice(0, index));
      if (history[history.length - 1]?.role !== 'user') return;
      const assistantId = newId();
      dispatch({
        type: 'truncateFrom',
        conversationId: conversation.id,
        messageId,
        assistantId,
        model: selectedModel,
        now: Date.now(),
      });
      void run(conversation.id, assistantId, selectedModel, history);
    },
    [run, selectedModel],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // Cancela qualquer geração ao desmontar.
  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    state,
    active,
    models,
    reloadModels: loadModels,
    selectedModel,
    chooseModel,
    isGenerating: state.generation !== null,
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
