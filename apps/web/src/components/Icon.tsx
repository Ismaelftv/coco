/**
 * Conjunto de ícones próprio (traço de 1.75 px, grelha de 20 px).
 * Decorativos por defeito (aria-hidden); o rótulo acessível fica no botão.
 */
const PATHS = {
  plus: 'M10 4v12M4 10h12',
  search: 'M8.75 15a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5ZM13.25 13.25 17 17',
  sidebar: 'M3.5 4.5h13a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM7.5 4.5v11',
  menu: 'M3.5 6h13M3.5 10h13M3.5 14h13',
  send: 'M10 16V4.5M5 9.5l5-5 5 5',
  stop: 'M6.5 6.5h7v7h-7z',
  paperclip:
    'M15.5 9.5 10 15a3.5 3.5 0 0 1-5-5l6-6a2.33 2.33 0 0 1 3.3 3.3l-6 6a1.17 1.17 0 0 1-1.65-1.65L12 6.3',
  copy: 'M7 7V4.5a1 1 0 0 1 1-1h7.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H13M4.5 7H12a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z',
  check: 'M4.5 10.5 8 14l7.5-8',
  refresh: 'M16 10a6 6 0 1 1-1.76-4.24M16 3.5V6.5h-3',
  more: 'M5 10h.01M10 10h.01M15 10h.01',
  trash: 'M4 6h12M8 6V4.5h4V6M5.5 6l.75 10h7.5L14.5 6',
  edit: 'M12.5 4.5l3 3L8 15H5v-3l7.5-7.5Z',
  chevronDown: 'M5.5 8l4.5 4.5L14.5 8',
  sun: 'M10 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1.06 1.06M14.24 14.24l1.06 1.06M4.7 15.3l1.06-1.06M14.24 5.76l1.06-1.06',
  moon: 'M16 11.5A6.5 6.5 0 0 1 8.5 4a6.5 6.5 0 1 0 7.5 7.5Z',
  monitor: 'M3.5 4.5h13v9h-13zM7.5 16.5h5M10 13.5v3',
  alert: 'M10 6.5v4.5M10 14h.01M8.6 3.4 2.7 14a1.6 1.6 0 0 0 1.4 2.4h11.8a1.6 1.6 0 0 0 1.4-2.4L11.4 3.4a1.6 1.6 0 0 0-2.8 0Z',
  close: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  folder: 'M3 6a1 1 0 0 1 1-1h3.5l1.5 1.5h7a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6Z',
  settings:
    'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM10 2.75v2M10 15.25v2M2.75 10h2M15.25 10h2M4.87 4.87l1.42 1.42M13.71 13.71l1.42 1.42M4.87 15.13l1.42-1.42M13.71 6.29l1.42-1.42',
  arrowDown: 'M10 4v12M5 11l5 5 5-5',
  file: 'M11.5 3H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6.5L11.5 3ZM11.5 3v3.5H15',
  spark: 'M10 3v4M10 13v4M3 10h4M13 10h4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Símbolo da marca Forja: “F” com terminais oblíquos, como uma marca de forja. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="logo">
      <rect x="1" y="1" width="30" height="30" rx="9" className="logo__plate" />
      <path d="M10.5 7.5h13l-2.2 4.2h-6.4v2.6h5.6l-2.2 4.2h-3.4v6h-4.4z" className="logo__glyph" />
    </svg>
  );
}
