import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/router';

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
