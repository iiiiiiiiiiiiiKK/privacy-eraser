import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'privacy-eraser:theme';

function readInitial(): Theme {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* storage can be blocked; fall through to the media query */
  }
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readInitial());

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((current) => (current === 'light' ? 'dark' : 'light')), []);
  return { theme, toggleTheme };
}
