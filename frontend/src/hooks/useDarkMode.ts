/**
 * Dark mode toggle hook with localStorage persistence.
 * On mount, reads the stored theme preference from localStorage.
 * Falls back to the OS-level `prefers-color-scheme` media query if no preference is stored.
 */
import { useState, useEffect } from 'react';

/**
 * Manages dark mode state and toggles the `dark` class on `<html>`.
 * Persists the user's preference to localStorage under the "theme" key.
 *
 * @returns Current dark mode state and a toggle callback
 */
export function useDarkMode() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('theme');
    switch (stored) {
      case 'dark':
        setIsDark(true);
        document.documentElement.classList.add('dark');
        break;
      case 'light':
        setIsDark(false);
        document.documentElement.classList.remove('dark');
        break;
      default: {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        setIsDark(prefersDark);
        if (prefersDark) document.documentElement.classList.add('dark');
      }
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
