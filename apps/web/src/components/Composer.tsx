import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { LIMITS } from '../../../../shared/limits.ts';
import type { MessageAttachment } from '../features/chat/types.ts';
import type { ModelsState } from '../features/chat/useChat.ts';
import {
  formatBytes,
  looksBinary,
  rejectionMessage,
  validateAttachment,
} from '../lib/attachments.ts';
import { Icon } from './Icon.tsx';
import { ModelPicker } from './ModelPicker.tsx';

interface DraftAttachment {
  id: string;
  name: string;
  size: number;
  mediaType: string;
  state: 'reading' | 'ready' | 'error';
  progress: number;
  content?: string;
  error?: string;
}

interface Props {
  isGenerating: boolean;
  canSend: boolean;
  models: ModelsState;
  selectedModel: string | null;
  onSelectModel(id: string): void;
  onRetryModels(): void;
  onSend(text: string, attachments: MessageAttachment[]): boolean;
  onStop(): void;
  autoFocusKey: string;
}

const MAX_HEIGHT_RATIO = 0.4;

export function Composer(props: Props) {
  const { isGenerating, canSend, onSend, onStop } = props;
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const readers = useRef(new Map<string, FileReader>());

  // Altura automática até 40% da janela.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * MAX_HEIGHT_RATIO)}px`;
  }, [text]);

  useEffect(() => {
    textarea.current?.focus();
  }, [props.autoFocusKey]);

  useEffect(() => {
    const active = readers.current;
    return () => active.forEach((r) => r.abort());
  }, []);

  const update = (id: string, patch: Partial<DraftAttachment>) =>
    setAttachments((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const addFiles = (files: FileList | File[]) => {
    let count = attachments.filter((a) => a.state !== 'error').length;
    const added: DraftAttachment[] = [];
    for (const file of Array.from(files)) {
      const id = crypto.randomUUID();
      const base = { id, name: file.name, size: file.size, mediaType: file.type || 'text/plain', progress: 0 };
      const rejection = validateAttachment(file, count);
      if (rejection) {
        added.push({ ...base, state: 'error', error: rejectionMessage(rejection) });
        continue;
      }
      count++;
      added.push({ ...base, state: 'reading' });
      const reader = new FileReader();
      readers.current.set(id, reader);
      reader.onprogress = (e) => {
        if (e.lengthComputable) update(id, { progress: e.loaded / e.total });
      };
      reader.onload = () => {
        readers.current.delete(id);
        const content = typeof reader.result === 'string' ? reader.result : '';
        if (looksBinary(content)) update(id, { state: 'error', error: 'Conteúdo binário detetado.' });
        else update(id, { state: 'ready', progress: 1, content });
      };
      reader.onerror = () => {
        readers.current.delete(id);
        update(id, { state: 'error', error: 'Não foi possível ler o ficheiro.' });
      };
      reader.readAsText(file);
    }
    setAttachments((list) => [...list, ...added]);
  };

  const removeAttachment = (id: string) => {
    readers.current.get(id)?.abort();
    readers.current.delete(id);
    setAttachments((list) => list.filter((a) => a.id !== id));
  };

  const reading = attachments.some((a) => a.state === 'reading');
  const ready = attachments.filter((a) => a.state === 'ready');
  const tooLong = text.length > LIMITS.messageChars;
  const hasContent = text.trim().length > 0 || ready.length > 0;
  const sendDisabled = !canSend || !hasContent || reading || tooLong;

  const submit = () => {
    if (isGenerating || sendDisabled) return;
    const payload: MessageAttachment[] = ready.map((a) => ({
      name: a.name,
      mediaType: a.mediaType,
      size: a.size,
      content: a.content ?? '',
    }));
    if (onSend(text.trim(), payload)) {
      setText('');
      setAttachments([]);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const remaining = LIMITS.messageChars - text.length;

  return (
    <div className="composer-dock">
      <div
        className={dragging ? 'composer is-dragging' : 'composer'}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {attachments.length > 0 ? (
          <ul className="composer__files" aria-label="Anexos a enviar">
            {attachments.map((a) => (
              <li key={a.id} className={`file-chip file-chip--${a.state}`} title={a.error ?? a.name}>
                <Icon name={a.state === 'error' ? 'alert' : 'file'} size={14} />
                <span className="file-chip__name">{a.name}</span>
                <span className="file-chip__meta">
                  {a.state === 'reading'
                    ? `A ler… ${Math.round(a.progress * 100)}%`
                    : a.state === 'error'
                      ? a.error
                      : formatBytes(a.size)}
                </span>
                <button
                  type="button"
                  className="file-chip__remove"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={`Remover ${a.name}`}
                >
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <label className="sr-only" htmlFor="composer-input">
          Mensagem
        </label>
        <textarea
          id="composer-input"
          ref={textarea}
          className="composer__input"
          rows={1}
          placeholder="Escreve uma mensagem…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }
          }}
          aria-describedby="composer-hint"
        />

        <div className="composer__toolbar">
          <div className="composer__tools">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              className="icon-btn"
              onClick={() => fileInput.current?.click()}
              aria-label="Anexar ficheiros de texto"
              title="Anexar ficheiros de texto"
            >
              <Icon name="paperclip" />
            </button>
            <ModelPicker
              models={props.models}
              selected={props.selectedModel}
              disabled={isGenerating}
              onSelect={props.onSelectModel}
              onRetry={props.onRetryModels}
            />
          </div>
          <div className="composer__send">
            {remaining < 2000 ? (
              <span className={tooLong ? 'composer__count is-over' : 'composer__count'} aria-live="polite">
                {remaining.toLocaleString('pt-PT')}
              </span>
            ) : null}
            {isGenerating ? (
              <button type="button" className="send-btn send-btn--stop" onClick={onStop} aria-label="Parar geração">
                <Icon name="stop" />
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                onClick={submit}
                disabled={sendDisabled}
                aria-label="Enviar mensagem"
              >
                <Icon name="send" />
              </button>
            )}
          </div>
        </div>
        {dragging ? <div className="composer__drop">Larga os ficheiros de texto aqui</div> : null}
      </div>
      <p id="composer-hint" className="composer-hint">
        Enter envia · Shift+Enter nova linha · Fornecedor simulado: as respostas não vêm de um modelo de IA.
      </p>
    </div>
  );
}
