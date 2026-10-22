import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const KEY = 'izaro:theme';
const systemTheme = (): Theme => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/** Switches between light and dark. Until it is used the app follows the system; index.html applies a saved choice before first paint. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme | undefined) ?? systemTheme());

  useEffect(() => {
    if (document.documentElement.dataset.theme) return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const follow = () => setTheme(systemTheme());
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private windows can refuse storage; the switch still works for this visit.
    }
    setTheme(next);
  };

  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <button type="button" className="theme-toggle" onClick={toggle} title={label} aria-label={label}>
      {theme === 'dark' ? '☀ Light' : '☾ Dark'}
    </button>
  );
}
