import { memo, useMemo } from 'react';
import { highlightToSafeHtml, normalizeLanguage } from '../lib/highlight.ts';
import { CopyButton } from './CopyButton.tsx';

export const CodeBlock = memo(function CodeBlock({ code, language }: { code: string; language?: string }) {
  const html = useMemo(() => highlightToSafeHtml(code, language), [code, language]);
  const label = normalizeLanguage(language) ?? language ?? 'texto';
  return (
    <figure className="code-block">
      <figcaption className="code-block__bar">
        <span className="code-block__lang">{label}</span>
        <CopyButton text={code} label="Copiar código" compact />
      </figcaption>
      <pre className="code-block__pre" tabIndex={0}>
        {html !== null ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </figure>
  );
});
