import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
const KEY = 'forja.theme';

function read(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Aplica a preferência antes da primeira renderização para evitar um flash do tema errado. */
export function applyStoredTheme(): void {
  apply(read());
}

function apply(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemePreference>(read);

  useEffect(() => apply(theme), [theme]);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* armazenamento indisponível: a preferência dura apenas esta sessão */
    }
  }, []);

  return { theme, setTheme };
}
