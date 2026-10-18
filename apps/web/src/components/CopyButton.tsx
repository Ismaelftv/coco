import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';

type CopyState = 'idle' | 'copied' | 'failed';

export function CopyButton({ text, label, compact = false }: { text: string; label: string; compact?: boolean }) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1600);
  };

  const feedback = state === 'copied' ? 'Copiado' : state === 'failed' ? 'Sem permissão' : null;
  return (
    <button
      type="button"
      className={compact ? 'btn btn--ghost btn--xs' : 'icon-btn'}
      onClick={copy}
      aria-label={feedback ?? label}
      title={label}
      data-state={state}
    >
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={compact ? 14 : 16} />
      {compact ? <span>{feedback ?? 'Copiar'}</span> : null}
      <span className="sr-only" role="status" aria-live="polite">
        {feedback ?? ''}
      </span>
    </button>
  );
}
