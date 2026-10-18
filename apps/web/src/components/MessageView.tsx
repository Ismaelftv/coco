import { memo } from 'react';
import type { Message } from '../features/chat/types.ts';
import { api } from '../lib/api.ts';
import { formatBytes } from '../lib/attachments.ts';
import type { FileInfo } from '../../../../shared/contract.ts';
import { CopyButton } from './CopyButton.tsx';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';

interface Props {
  message: Message;
  isLast: boolean;
  canRegenerate: boolean;
  onRegenerate(messageId: string): void;
}

export const MessageView = memo(function MessageView({ message, isLast, canRegenerate, onRegenerate }: Props) {
  if (message.role === 'user') {
    return (
      <article className="msg msg--user" aria-label="A tua mensagem">
        <div className="msg__bubble">
          {message.files.length ? <FileList files={message.files} /> : null}
          {message.content ? <p className="msg__text">{message.content}</p> : null}
        </div>
        <div className="msg__actions msg__actions--user">
          {message.content ? <CopyButton text={message.content} label="Copiar mensagem" /> : null}
        </div>
      </article>
    );
  }

  const streaming = message.status === 'streaming';
  const waiting = streaming && message.content.length === 0;

  return (
    <article
      className="msg msg--assistant"
      aria-label="Resposta do assistente"
      aria-busy={streaming}
      data-status={message.status}
    >
      {waiting ? (
        <div className="thinking" role="status">
          <span className="thinking__dot" />
          <span className="thinking__dot" />
          <span className="thinking__dot" />
          <span className="sr-only">A gerar resposta…</span>
        </div>
      ) : null}

      {message.content ? (
        <div className={streaming ? 'msg__body is-streaming' : 'msg__body'}>
          <Markdown source={message.content} />
        </div>
      ) : null}

      {message.status === 'cancelled' ? (
        <p className="msg__note">
          <Icon name="stop" size={14} /> Geração interrompida.
        </p>
      ) : null}

      {message.status === 'error' && message.error ? (
        <div className="callout callout--danger" role="alert">
          <Icon name="alert" size={18} />
          <div className="callout__body">
            <p className="callout__title">Não foi possível concluir a resposta.</p>
            <p className="callout__text">
              {message.error.message} <code className="callout__code">{message.error.code}</code>
            </p>
          </div>
          {isLast ? (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => onRegenerate(message.id)}
              disabled={!canRegenerate}
            >
              <Icon name="refresh" size={16} />
              Repetir
            </button>
          ) : null}
        </div>
      ) : null}

      {!streaming && message.status !== 'error' ? (
        <div className="msg__actions">
          {message.content ? <CopyButton text={message.content} label="Copiar resposta" /> : null}
          {isLast ? (
            <button
              type="button"
              className="icon-btn"
              onClick={() => onRegenerate(message.id)}
              disabled={!canRegenerate}
              aria-label="Regenerar resposta"
              title="Regenerar resposta"
            >
              <Icon name="refresh" size={16} />
            </button>
          ) : null}
          {message.usage ? (
            <span
              className="msg__meta"
              title="Estimativa: o fornecedor simulado não usa um tokenizador real."
            >
              ≈{message.usage.outputTokens} tokens
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

function FileList({ files }: { files: FileInfo[] }) {
  return (
    <ul className="msg__attachments" aria-label="Anexos">
      {files.map((f) =>
        f.kind === 'image' ? (
          <li key={f.id}>
            <a className="file-thumb" href={api.fileUrl(f.id)} target="_blank" rel="noopener" title={f.name}>
              <img src={api.fileUrl(f.id)} alt={f.name} loading="lazy" decoding="async" />
            </a>
          </li>
        ) : (
          <li key={f.id}>
            <a className="file-chip file-chip--static file-chip--link" href={api.fileUrl(f.id)} download={f.name}>
              <Icon name="file" size={14} />
              <span className="file-chip__name">{f.name}</span>
              <span className="file-chip__meta">
                {f.kind === 'pdf' ? 'PDF · ' : ''}
                {formatBytes(f.size)}
              </span>
            </a>
          </li>
        ),
      )}
    </ul>
  );
}
