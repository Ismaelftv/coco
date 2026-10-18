/**
 * Renderização segura de Markdown (ADR-0005).
 * `marked` é usado apenas como lexer; cada token é convertido num elemento
 * React. Não há `innerHTML` para o conteúdo do modelo:
 *  - HTML embutido é mostrado como texto;
 *  - imagens não são carregadas (mostra-se uma ligação), evitando pedidos a terceiros;
 *  - ligações só com http(s)/mailto, abertas num novo separador sem referrer.
 */
import { memo, useMemo, type ReactNode } from 'react';
import { Lexer, type Token, type Tokens } from 'marked';
import { safeHref } from '../lib/url.ts';
import { CodeBlock } from './CodeBlock.tsx';

const ENTITY: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
export function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITY[m] ?? m);
}

function inline(tokens: Token[] | undefined, keyPrefix: string): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => renderInline(t, `${keyPrefix}.${i}`));
}

function renderInline(token: Token, key: string): ReactNode {
  switch (token.type) {
    case 'text': {
      const t = token as Tokens.Text;
      return t.tokens ? <span key={key}>{inline(t.tokens, key)}</span> : decodeEntities(t.text);
    }
    case 'escape':
      return decodeEntities((token as Tokens.Escape).text);
    case 'strong':
      return <strong key={key}>{inline((token as Tokens.Strong).tokens, key)}</strong>;
    case 'em':
      return <em key={key}>{inline((token as Tokens.Em).tokens, key)}</em>;
    case 'del':
      return <del key={key}>{inline((token as Tokens.Del).tokens, key)}</del>;
    case 'codespan':
      return (
        <code key={key} className="md-code-inline">
          {decodeEntities((token as Tokens.Codespan).text)}
        </code>
      );
    case 'br':
      return <br key={key} />;
    case 'link': {
      const t = token as Tokens.Link;
      const href = safeHref(t.href);
      const children = inline(t.tokens, key);
      if (!href) return <span key={key}>{children}</span>;
      return (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" title={t.title ?? undefined}>
          {children}
        </a>
      );
    }
    case 'image': {
      const t = token as Tokens.Image;
      const href = safeHref(t.href);
      const label = `Imagem: ${t.text || 'sem descrição'}`;
      return href ? (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
          {label}
        </a>
      ) : (
        <span key={key}>{label}</span>
      );
    }
    case 'html':
      return (token as Tokens.HTML).text;
    default:
      return 'raw' in token ? String(token.raw) : null;
  }
}

function renderBlock(token: Token, key: string): ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'heading': {
      const t = token as Tokens.Heading;
      const children = inline(t.tokens, key);
      // h1 do modelo é rebaixado para não competir com o título da página.
      if (t.depth <= 2) return <h3 key={key} className="md-h md-h--2">{children}</h3>;
      if (t.depth === 3) return <h4 key={key} className="md-h md-h--3">{children}</h4>;
      return <h5 key={key} className="md-h md-h--4">{children}</h5>;
    }
    case 'paragraph':
      return <p key={key}>{inline((token as Tokens.Paragraph).tokens, key)}</p>;
    case 'text': {
      const t = token as Tokens.Text;
      return <p key={key}>{t.tokens ? inline(t.tokens, key) : decodeEntities(t.text)}</p>;
    }
    case 'blockquote':
      return <blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens, key)}</blockquote>;
    case 'hr':
      return <hr key={key} />;
    case 'code': {
      const t = token as Tokens.Code;
      return <CodeBlock key={key} code={t.text} language={t.lang || undefined} />;
    }
    case 'list': {
      const t = token as Tokens.List;
      const items = t.items.map((item, i) => {
        const k = `${key}.${i}`;
        const content = item.tokens.map((child, j) =>
          // Em listas compactas, o texto vem como token 'text' — sem <p>.
          child.type === 'text' && !t.loose
            ? renderInline(child, `${k}.${j}`)
            : renderBlock(child, `${k}.${j}`),
        );
        return (
          <li key={k} className={item.task ? 'md-task' : undefined}>
            {item.task ? (
              <span className="md-task__box" aria-label={item.checked ? 'Concluído' : 'Por fazer'} role="img">
                {item.checked ? '☑' : '☐'}
              </span>
            ) : null}
            {content}
          </li>
        );
      });
      return t.ordered ? (
        <ol key={key} start={typeof t.start === 'number' ? t.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'table': {
      const t = token as Tokens.Table;
      const align = (i: number) => t.align[i] ?? undefined;
      return (
        <div key={key} className="md-table-wrap" tabIndex={0} role="region" aria-label="Tabela">
          <table>
            <thead>
              <tr>
                {t.header.map((cell, i) => (
                  <th key={i} scope="col" style={{ textAlign: align(i) ?? undefined }}>
                    {inline(cell.tokens, `${key}.h${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} style={{ textAlign: align(i) ?? undefined }}>
                      {inline(cell.tokens, `${key}.${r}.${i}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'html':
      return (
        <p key={key} className="md-raw-html">
          {(token as Tokens.HTML).text}
        </p>
      );
    default:
      return renderInline(token, key);
  }
}

function blocks(tokens: Token[], keyPrefix: string): ReactNode[] {
  return tokens.map((t, i) => renderBlock(t, `${keyPrefix}.${i}`));
}

export const Markdown = memo(function Markdown({ source }: { source: string }) {
  const tokens = useMemo(() => Lexer.lex(source, { gfm: true, breaks: false }), [source]);
  return <div className="md">{blocks(tokens, 'b')}</div>;
});
