// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sidebar state management for mobile toggle and desktop collapse.
 * Automatically closes the mobile sidebar on route changes.
 * Persists collapsed state in localStorage.
 */
import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/router';

const COLLAPSED_KEY = 'sidebar-collapsed';

/**
 * Manages mobile sidebar open/close state and desktop collapsed state.
 * Listens for Next.js route changes and auto-closes the sidebar on navigation.
 */
export function useSidebarState() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const router = useRouter();

  // Restore collapsed state from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(COLLAPSED_KEY);
      if (stored === 'true') setCollapsed(true);
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Close mobile sidebar on route change
  useEffect(() => {
    const handleRouteChange = () => setMobileOpen(false);
    router.events.on('routeChangeComplete', handleRouteChange);
    return () => router.events.off('routeChangeComplete', handleRouteChange);
  }, [router]);

  const openMobile = useCallback(() => setMobileOpen(true), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const toggleMobile = useCallback(() => setMobileOpen((prev) => !prev), []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch { /* localStorage may be unavailable */ }
      return next;
    });
  }, []);

  return { mobileOpen, openMobile, closeMobile, toggleMobile, collapsed, toggleCollapsed };
}
