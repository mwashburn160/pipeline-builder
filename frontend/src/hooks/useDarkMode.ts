/**
 * Dark mode toggle hook with localStorage persistence.
 * On mount, reads the stored theme preference from localStorage.
 * Falls back to the OS-level `prefers-color-scheme` media query if no preference is stored.
 */
import { useState, useEffect } from 'react';

/** Read initial dark mode preference synchronously to prevent flash of wrong theme. */
export function getInitialDark(): boolean {
  if (typeof window === 'undefined') return false;
  const stored = localStorage.getItem('theme');
  if (stored === 'dark') return true;
  if (stored === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Manages dark mode state and toggles the `dark` class on `<html>`.
 * Persists the user's preference to localStorage under the "theme" key.
 *
 * @returns Current dark mode state and a toggle callback
 */
export function useDarkMode() {
  const [isDark, setIsDark] = useState(getInitialDark);

  // Sync the DOM class on first render (synchronous init handles state, effect handles class)
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, []);

  const toggle = () => {
    const next = !isDark;
    setIsDark(next);
    if (next) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  };

  return { isDark, toggle };
}
