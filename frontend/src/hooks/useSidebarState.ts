/**
 * Sidebar mobile toggle state management.
 * Automatically closes the mobile sidebar on route changes.
 */
import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/router';

/**
 * Manages mobile sidebar open/close state.
 * Listens for Next.js route changes and auto-closes the sidebar on navigation.
 *
 * @returns Mobile sidebar state and open/close/toggle callbacks
 */
export function useSidebarState() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const router = useRouter();

  // Close mobile sidebar on route change
  useEffect(() => {
    const handleRouteChange = () => setMobileOpen(false);
    router.events.on('routeChangeComplete', handleRouteChange);
    return () => router.events.off('routeChangeComplete', handleRouteChange);
  }, [router]);

  const openMobile = useCallback(() => setMobileOpen(true), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const toggleMobile = useCallback(() => setMobileOpen((prev) => !prev), []);

  return { mobileOpen, openMobile, closeMobile, toggleMobile };
}
