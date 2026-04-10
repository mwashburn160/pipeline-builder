// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Dark mode toggle hook with localStorage persistence.
 * On mount, reads the stored theme preference from localStorage.
 * Falls back to the OS-level `prefers-color-scheme` media query if no preference is stored.
 */
import { useState, useEffect } from 'react';
import { THEME_STORAGE_KEY } from '@/lib/constants';

/** Read initial dark mode preference synchronously to prevent flash of wrong theme. */
export function getInitialDark(): boolean {
  if (typeof window === 'undefined') return false;
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
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

  // Single source of truth: sync DOM class and localStorage whenever isDark changes
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    localStorage.setItem(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
  }, [isDark]);

  const toggle = () => setIsDark(prev => !prev);

  return { isDark, toggle };
}
