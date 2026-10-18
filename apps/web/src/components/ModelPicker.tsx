import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelInfo } from '../../../../shared/contract.ts';
import type { ModelsState } from '../features/chat/useChat.ts';
import { Icon } from './Icon.tsx';

interface Props {
  models: ModelsState;
  selected: string | null;
  disabled: boolean;
  onSelect(id: string): void;
  onRetry(): void;
}

const STATUS_LABEL: Record<ModelInfo['status'], string> = {
  available: 'Disponível',
  simulated: 'Simulado',
  'requires-integration': 'Requer integração',
};

/** Listbox acessível (padrão WAI-ARIA "select-only combobox" simplificado). */
export function ModelPicker({ models, selected, disabled, onSelect, onRetry }: Props) {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();

  const list = models.status === 'ready' ? models.models : [];
  const current = list.find((m) => m.id === selected);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!listRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  if (models.status === 'loading') {
    return (
      <span className="model-picker model-picker--loading" role="status">
        <span className="skeleton skeleton--text" /> <span className="sr-only">A carregar modelos…</span>
      </span>
    );
  }
  if (models.status === 'error') {
    return (
      <button type="button" className="model-picker model-picker--error" onClick={onRetry}>
        <Icon name="alert" size={14} /> Modelos indisponíveis · Repetir
      </button>
    );
  }

  const openList = () => {
    const idx = Math.max(0, list.findIndex((m) => m.id === selected));
    setFocusIndex(idx);
    setOpen(true);
  };

  const choose = (m: ModelInfo | undefined) => {
    if (!m || m.status === 'requires-integration') return;
    onSelect(m.id);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIndex((i) => Math.min(list.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setFocusIndex(list.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(list[focusIndex]);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }
  };

  return (
    <div className="model-picker-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="model-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Modelo: ${current?.label ?? 'nenhum'}`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            openList();
          }
        }}
      >
        <span className="model-picker__label">{current?.label ?? 'Escolher modelo'}</span>
        {current && current.status !== 'available' ? (
          <span className={`badge badge--${current.status}`}>{STATUS_LABEL[current.status]}</span>
        ) : null}
        <Icon name="chevronDown" size={14} />
      </button>
      {open ? (
        <ul
          ref={listRef}
          id={listId}
          className="popover model-list"
          role="listbox"
          tabIndex={-1}
          aria-label="Modelos"
          aria-activedescendant={list[focusIndex] ? `${listId}-${focusIndex}` : undefined}
          onKeyDown={onListKey}
        >
          {list.map((m, i) => {
            const unavailable = m.status === 'requires-integration';
            return (
              <li
                key={m.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={m.id === selected}
                aria-disabled={unavailable}
                className={i === focusIndex ? 'model-option is-focused' : 'model-option'}
                onMouseEnter={() => setFocusIndex(i)}
                onClick={() => choose(m)}
              >
                <span className="model-option__head">
                  <span className="model-option__name">{m.label}</span>
                  <span className={`badge badge--${m.status}`}>{STATUS_LABEL[m.status]}</span>
                  {m.id === selected ? <Icon name="check" size={16} className="model-option__check" /> : null}
                </span>
                <span className="model-option__desc">{m.description}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
