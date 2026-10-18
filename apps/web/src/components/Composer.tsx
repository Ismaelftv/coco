import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { FileInfo } from '../../../../shared/contract.ts';
import { LIMITS } from '../../../../shared/limits.ts';
import type { ModelsState } from '../features/chat/useChat.ts';
import { api, uploadFile, type UploadHandle } from '../lib/api.ts';
import { formatBytes, rejectionMessage, validateAttachment } from '../lib/attachments.ts';
import { Icon } from './Icon.tsx';
import { ModelPicker } from './ModelPicker.tsx';

interface DraftAttachment {
  key: string;
  name: string;
  size: number;
  state: 'uploading' | 'ready' | 'error';
  progress: number;
  file?: FileInfo;
  error?: string;
}

interface Props {
  isGenerating: boolean;
  canSend: boolean;
  models: ModelsState;
  selectedModel: string | null;
  onSelectModel(id: string): void;
  onRetryModels(): void;
  onSend(text: string, files: FileInfo[]): boolean;
  onStop(): void;
  autoFocusKey: string;
  /** Quem gera as respostas (mostrado por baixo da caixa de texto). */
  modelNote: string;
}

const MAX_HEIGHT_RATIO = 0.4;

export function Composer(props: Props) {
  const { isGenerating, canSend, onSend, onStop } = props;
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const uploads = useRef(new Map<string, UploadHandle>());

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
    const active = uploads.current;
    return () => active.forEach((u) => u.abort());
  }, []);

  const update = (key: string, patch: Partial<DraftAttachment>) =>
    setAttachments((list) => list.map((a) => (a.key === key ? { ...a, ...patch } : a)));

  const addFiles = (files: FileList | File[]) => {
    let count = attachments.filter((a) => a.state !== 'error').length;
    const added: DraftAttachment[] = [];
    for (const file of Array.from(files)) {
      const key = crypto.randomUUID();
      const base = { key, name: file.name, size: file.size, progress: 0 };
      const rejection = validateAttachment(file, count);
      if (rejection) {
        added.push({ ...base, state: 'error', error: rejectionMessage(rejection) });
        continue;
      }
      count++;
      added.push({ ...base, state: 'uploading' });
      const handle = uploadFile(file, (progress) => update(key, { progress }));
      uploads.current.set(key, handle);
      handle.promise
        .then((info) => update(key, { state: 'ready', progress: 1, file: info }))
        .catch((err: Error) => {
          if ((err as { code?: string }).code !== 'aborted') update(key, { state: 'error', error: err.message });
        })
        .finally(() => uploads.current.delete(key));
    }
    setAttachments((list) => [...list, ...added]);
  };

  const removeAttachment = (a: DraftAttachment) => {
    uploads.current.get(a.key)?.abort();
    uploads.current.delete(a.key);
    // Um ficheiro já enviado mas não usado é apagado do servidor.
    if (a.file) void api.deleteFile(a.file.id).catch(() => undefined);
    setAttachments((list) => list.filter((x) => x.key !== a.key));
  };

  const uploading = attachments.some((a) => a.state === 'uploading');
  const ready = attachments.filter((a): a is DraftAttachment & { file: FileInfo } => a.state === 'ready' && !!a.file);
  const tooLong = text.length > LIMITS.messageChars;
  const hasContent = text.trim().length > 0 || ready.length > 0;
  const sendDisabled = !canSend || !hasContent || uploading || tooLong;

  const submit = () => {
    if (isGenerating || sendDisabled) return;
    if (onSend(text.trim(), ready.map((a) => a.file))) {
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
              <li key={a.key} className={`file-chip file-chip--${a.state}`} title={a.error ?? a.name}>
                <Icon name={a.state === 'error' ? 'alert' : 'file'} size={14} />
                <span className="file-chip__name">{a.name}</span>
                <span className="file-chip__meta">
                  {a.state === 'uploading'
                    ? `A enviar… ${Math.round(a.progress * 100)}%`
                    : a.state === 'error'
                      ? a.error
                      : formatBytes(a.size)}
                </span>
                <button
                  type="button"
                  className="file-chip__remove"
                  onClick={() => removeAttachment(a)}
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
              aria-label="Anexar ficheiros"
              title="Anexar ficheiros (texto, imagens, PDF)"
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
        {dragging ? <div className="composer__drop">Larga os ficheiros aqui</div> : null}
      </div>
      <p id="composer-hint" className="composer-hint">
        Enter envia · Shift+Enter nova linha · {props.modelNote}
      </p>
    </div>
  );
}
