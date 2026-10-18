import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '../features/chat/types.ts';
import { Icon } from './Icon.tsx';
import { MessageView } from './MessageView.tsx';

const STICK_THRESHOLD_PX = 96;

interface Props {
  conversationId: string;
  messages: Message[];
  isGenerating: boolean;
  onRegenerate(messageId: string): void;
}

/**
 * Lista de mensagens com "scroll pegajoso": acompanha o fim durante o
 * streaming apenas enquanto o utilizador não subir para ler.
 */
export function MessageList({ conversationId, messages, isGenerating, onRegenerate }: Props) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToEnd = useCallback((smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Nova conversa: começar no fim.
  useLayoutEffect(() => {
    stick.current = true;
    setShowJump(false);
    scrollToEnd(false);
  }, [conversationId, scrollToEnd]);

  // Conteúdo novo: acompanhar se o utilizador estiver junto ao fim.
  useLayoutEffect(() => {
    if (stick.current) scrollToEnd(false);
  }, [messages, scrollToEnd]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = distance < STICK_THRESHOLD_PX;
    setShowJump(!stick.current);
  };

  // Ao enviar uma mensagem nova, voltar a acompanhar o fim.
  const lastUserId = [...messages].reverse().find((m) => m.role === 'user')?.id;
  useEffect(() => {
    stick.current = true;
    scrollToEnd(true);
  }, [lastUserId, scrollToEnd]);

  return (
    <div className="thread" ref={scroller} onScroll={onScroll}>
      <div className="thread__inner" role="log" aria-live="off" aria-label="Conversa">
        {messages.map((m, i) => (
          <MessageView
            key={m.id}
            message={m}
            isLast={i === messages.length - 1}
            canRegenerate={!isGenerating}
            onRegenerate={onRegenerate}
          />
        ))}
      </div>
      {showJump ? (
        <button
          type="button"
          className="jump-to-end"
          onClick={() => {
            stick.current = true;
            scrollToEnd(true);
          }}
        >
          <Icon name="arrowDown" size={16} />
          <span>Ir para o fim</span>
        </button>
      ) : null}
    </div>
  );
}
