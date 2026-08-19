import { useState, useEffect, useCallback, useRef } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Menu, X, Bell, Search, HelpCircle } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFeatures } from '@/hooks/useFeatures';
import { useDarkMode } from '@/hooks/useDarkMode';
import { useSidebarState } from '@/hooks/useSidebarState';
import { Sidebar } from './Sidebar';
import { Breadcrumb, type BreadcrumbItem } from './Breadcrumb';
import { CommandPalette } from './CommandPalette';
import { OrgSwitcher } from './OrgSwitcher';
import { LoadingPage } from './Loading';
import { QuotaBanner } from './QuotaBanner';
import { ImpersonationBanner } from './ImpersonationBanner';
import { AuthErrorBanner } from './AuthErrorBanner';
import { ErrorBoundary } from '../ErrorBoundary';
import { StepUpModal } from '@/components/admin/StepUpModal';
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
  const { user, isReady, isSuperAdmin, isAdmin, logout } = useAuthGuard();
  const { isLoaded: featuresLoaded } = useFeatures();
  const { isDark, toggle } = useDarkMode();
  const { mobileOpen, toggleMobile, closeMobile, collapsed, toggleCollapsed } = useSidebarState();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const cmdkRef = useRef<() => void>(null);
  const mobileDrawerRef = useRef<HTMLDivElement>(null);

  // Global catch-all for stale step-up tokens. When a destructive API
  // call returns 401 STEP_UP_REQUIRED / INVALID / MISMATCH, the api
  // client throws StepUpRequiredError AND dispatches `step-up-required`.
  // We surface a modal here so a stale tab gets a clear re-prompt path
  // instead of a confusing generic "Authentication required" toast.
  // The modal acquires a fresh token; the user retries the action
  // manually (no auto-replay — we don't safely know which fn to retry).
  const [stepUpFallback, setStepUpFallback] = useState<{ message: string } | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message?: string };
      setStepUpFallback({ message: detail?.message || 'Step-up confirmation required' });
    };
    window.addEventListener('step-up-required', handler);
    return () => window.removeEventListener('step-up-required', handler);
  }, []);

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

  // Mobile drawer focus management: when the drawer opens, move focus into it,
  // keep Tab cycling within it, and close on Escape. The drawer is a fixed
  // overlay with no native dialog semantics, so this has to be wired by hand.
  useEffect(() => {
    if (!mobileOpen) return;
    const drawer = mobileDrawerRef.current;
    const getFocusable = () =>
      drawer
        ? Array.from(
            drawer.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];
    getFocusable()[0]?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMobile();
        return;
      }
      if (e.key === 'Tab') {
        const els = getFocusable();
        if (els.length === 0) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen, closeMobile]);

  if (!isReady || !user || !featuresLoaded) return <LoadingPage />;

  const sidebarWidth = collapsed ? 'lg:w-16' : 'lg:w-64';
  const contentMargin = collapsed ? 'lg:ml-16' : 'lg:ml-64';

  const sidebarProps = {
    isSuperAdmin,
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
        {/* Skip link — first tab stop; jumps keyboard/AT users past the nav
            straight to page content. Visually hidden until focused. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[60] focus:px-3 focus:py-2 focus:rounded-lg focus:bg-blue-600 focus:text-white focus:shadow-lg"
        >
          Skip to content
        </a>
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
                ref={mobileDrawerRef}
                initial={{ x: -256 }}
                animate={{ x: 0 }}
                exit={{ x: -256 }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className="fixed inset-y-0 left-0 w-64 z-50 lg:hidden"
                role="dialog"
                aria-modal="true"
                aria-label="Navigation menu"
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
                {/* Organization / team context — top-left anchor, visible on
                    every page. Becomes an interactive switcher at 2+ orgs. */}
                <OrgSwitcher variant="header" />
                <div className="hidden sm:block h-8 w-px bg-gray-200 dark:bg-gray-700" aria-hidden />
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
                {/* Search / command palette (⌘K) — icon button; the shortcut
                    lives in the tooltip rather than a hard-to-see kbd chip. */}
                <button
                  onClick={() => cmdkRef.current?.()}
                  aria-label="Open command palette"
                  title="Search & commands (⌘K)"
                  className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <Search className="w-5 h-5" />
                </button>
                {/* Notification bell — global unread-messages indicator. Mirrors
                    the Messages sidebar badge but stays visible on every page
                    (and when the sidebar is collapsed). */}
                <Link
                  href="/dashboard/messages"
                  aria-label={unreadCount > 0 ? `Messages — ${unreadCount} unread` : 'Messages'}
                  className="relative p-1.5 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <Bell className="w-5 h-5" />
                  {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-bold text-white bg-red-500 rounded-full">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </Link>
                {/* Help — always available from the topbar (not buried in the
                    collapsible Settings nav section). */}
                <Link
                  href="/dashboard/help"
                  aria-label="Help"
                  title="Help"
                  className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <HelpCircle className="w-5 h-5" />
                </Link>
                {actions}
              </div>
            </div>
          </header>

          <ImpersonationBanner />
          <AuthErrorBanner />
          <QuotaBanner />

          <main id="main-content" tabIndex={-1} className={`page-reveal ${maxWidthClasses[maxWidth]} mx-auto w-full py-6 px-4 sm:px-6 lg:px-8 ${mainClassName}`}>
            <ErrorBoundary resetKey={router.asPath}>
              {children}
            </ErrorBoundary>
          </main>
        </div>

        {/* Command Palette */}
        <CommandPalette
          isSuperAdmin={isSuperAdmin}
          isAdmin={isAdmin}
          isDark={isDark}
          onToggleDark={toggle}
          onOpenRef={cmdkRef}
        />

        {/* Global step-up fallback. Fires when ANY api method returns
            401 with a STEP_UP_* code — i.e. the user clicked a
            destructive action without a fresh step-up token. The modal
            obtains one; the user re-clicks the original action. */}
        {stepUpFallback && (
          <StepUpModal
            action={`Re-confirm to retry. ${stepUpFallback.message}`}
            onConfirmed={() => {
              // The token is fresh now; the user must re-click their original
              // action. We don't auto-retry here because the api client throws
              // before we know which call to replay.
            }}
            onClose={() => setStepUpFallback(null)}
          />
        )}
      </div>
    </>
  );
}
