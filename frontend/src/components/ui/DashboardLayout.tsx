import { useState, useEffect, useCallback, useRef } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { Menu, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFeatures } from '@/hooks/useFeatures';
import { useDarkMode } from '@/hooks/useDarkMode';
import { useSidebarState } from '@/hooks/useSidebarState';
import { Sidebar } from './Sidebar';
import { Breadcrumb, type BreadcrumbItem } from './Breadcrumb';
import { CommandPalette } from './CommandPalette';
import { LoadingPage } from './Loading';
import { ErrorBoundary } from '../ErrorBoundary';
import api from '@/lib/api';
import { POLL_INTERVAL } from '@/hooks/useMessages';

interface DashboardLayoutProps {
  title: string;
  children: React.ReactNode;
  titleExtra?: React.ReactNode;
  actions?: React.ReactNode;
  maxWidth?: '3xl' | '4xl' | '7xl';
  mainClassName?: string;
  breadcrumbs?: BreadcrumbItem[];
  subtitle?: React.ReactNode;
}

const maxWidthClasses = {
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '7xl': 'max-w-7xl',
};

export function DashboardLayout({
  title,
  children,
  titleExtra,
  actions,
  maxWidth = '7xl',
  mainClassName = '',
  breadcrumbs,
  subtitle,
}: DashboardLayoutProps) {
  const { user, isReady, isSysAdmin, isAdmin, logout } = useAuthGuard();
  const { isLoaded: featuresLoaded } = useFeatures();
  const { isDark, toggle } = useDarkMode();
  const { mobileOpen, toggleMobile, closeMobile, collapsed, toggleCollapsed } = useSidebarState();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const cmdkRef = useRef<() => void>(null);

  const fetchUnreadCount = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const result = await api.getUnreadCount();
      setUnreadCount(result.data?.count || 0);
    } catch {
      // Silently fail — message service may not be running
    }
  }, []);

  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  if (!isReady || !user || !featuresLoaded) return <LoadingPage />;

  const sidebarWidth = collapsed ? 'lg:w-16' : 'lg:w-64';
  const contentMargin = collapsed ? 'lg:ml-16' : 'lg:ml-64';

  const sidebarProps = {
    isSysAdmin,
    isAdmin,
    user,
    unreadCount,
    currentPath: router.pathname,
    isDark,
    onToggleDark: toggle,
    onLogout: logout,
  };

  return (
    <>
      <Head>
        <title>{title} - Pipeline Builder</title>
      </Head>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors flex">
        {/* Desktop sidebar */}
        <div className={`hidden lg:flex ${sidebarWidth} lg:flex-shrink-0 lg:fixed lg:inset-y-0 transition-all duration-200`}>
          <Sidebar {...sidebarProps} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        </div>

        {/* Mobile sidebar overlay */}
        <AnimatePresence>
          {mobileOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm z-40 lg:hidden"
                onClick={closeMobile}
              />
              <motion.div
                initial={{ x: -256 }}
                animate={{ x: 0 }}
                exit={{ x: -256 }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className="fixed inset-y-0 left-0 w-64 z-50 lg:hidden"
              >
                <Sidebar {...sidebarProps} />
                <button
                  onClick={closeMobile}
                  className="absolute top-4 right-[-44px] p-2 rounded-lg bg-white/90 dark:bg-gray-800/90 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 shadow-lg"
                  aria-label="Close sidebar"
                >
                  <X className="w-5 h-5" />
                </button>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* Main content area */}
        <div className={`flex-1 flex flex-col min-w-0 ${contentMargin} transition-all duration-200`}>
          {/* Slim top bar */}
          <header className="sticky top-0 z-30 bg-white/80 dark:bg-gray-900/80 backdrop-blur-md border-b border-gray-200/60 dark:border-gray-700/60 shadow-[0_8px_24px_rgba(15,23,42,0.06)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
            <div className="px-4 sm:px-6 lg:px-8 py-3 flex justify-between items-center">
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleMobile}
                  className="lg:hidden p-1.5 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  aria-label="Open menu"
                >
                  <Menu className="w-5 h-5" />
                </button>
                <div className="min-w-0">
                  {breadcrumbs && <Breadcrumb items={breadcrumbs} />}
                  <div className="flex items-center gap-3">
                    <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
                    {titleExtra}
                  </div>
                  {subtitle && (
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 truncate">
                      {subtitle}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                {/* Cmd+K hint */}
                <button
                  onClick={() => cmdkRef.current?.()}
                  className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 transition-colors"
                >
                  <kbd className="font-medium">⌘K</kbd>
                </button>
                {actions}
              </div>
            </div>
          </header>

          <main className={`page-reveal ${maxWidthClasses[maxWidth]} mx-auto w-full py-6 px-4 sm:px-6 lg:px-8 ${mainClassName}`}>
            <ErrorBoundary>
              {children}
            </ErrorBoundary>
          </main>
        </div>

        {/* Command Palette */}
        <CommandPalette
          isSysAdmin={isSysAdmin}
          isAdmin={isAdmin}
          isDark={isDark}
          onToggleDark={toggle}
          onOpenRef={cmdkRef}
        />
      </div>
    </>
  );
}
