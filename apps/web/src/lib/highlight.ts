/**
 * Realce de sintaxe com highlight.js (núcleo + linguagens registadas
 * explicitamente, para controlar o tamanho do bundle).
 * O HTML gerado é sanitizado para permitir apenas <span class>.
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import DOMPurify from 'dompurify';

const LANGUAGES = { bash, css, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml };
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def);

const ALIASES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', html: 'xml', svg: 'xml',
  yml: 'yaml', md: 'markdown', rs: 'rust', golang: 'go',
};

export function normalizeLanguage(lang: string | undefined): string | null {
  if (!lang) return null;
  const key = lang.trim().toLowerCase().split(/\s+/)[0] ?? '';
  const resolved = ALIASES[key] ?? key;
  return hljs.getLanguage(resolved) ? resolved : null;
}

const MAX_HIGHLIGHT_CHARS = 60_000;

/** Devolve HTML seguro, ou null se não houver gramática (o chamador mostra texto simples). */
export function highlightToSafeHtml(code: string, lang: string | undefined): string | null {
  const language = normalizeLanguage(lang);
  if (!language || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] });
}
