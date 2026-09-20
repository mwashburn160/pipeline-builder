import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Menu, X, Bell, Search, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { useDialogBehavior } from '@/hooks/useDialogBehavior';
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
import { MfaRequiredBanner } from './MfaRequiredBanner';
import { MfaRequiredDialog } from './MfaRequiredDialog';
import { ErrorBoundary } from '../ErrorBoundary';
import { FeatureLockedAction } from './FeatureLock';
import { useToast } from './Toast';
import { formatError } from '@/lib/constants';
import { POLL_INTERVAL } from '@/hooks/useMessages';
import { usePolling } from '@/hooks/usePolling';
import { pollUnreadCount, useUnreadCount } from '@/lib/unread-count-store';

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

// The global step-up dialog and the Ask panel are ~400 lines each and only ever
// open on demand, so they load as their own chunks the first time they're needed
// instead of riding along on every dashboard route. Nothing can be lost while a
// chunk loads: the step-up REQUEST lives in this layout's state (set by the
// always-mounted `step-up-required` listener below) and the dialog renders from
// that state as soon as its code arrives, `retry` and all.
const StepUpModal = dynamic(
  () => import('@/components/admin/StepUpModal').then((m) => m.StepUpModal),
  { ssr: false, loading: () => null },
);
const AskPanel = dynamic(
  () => import('@/components/ask/AskPanel').then((m) => m.AskPanel),
  { ssr: false, loading: () => null },
);

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
  const toast = useToast();
  // Ask rides the ai_generation entitlement (the ask service enforces it too).
  const askGate = useFeatureGate('ai_generation');
  const featuresLoaded = askGate.isLoaded;
  const { isDark, toggle } = useDarkMode();
  const { mobileOpen, toggleMobile, closeMobile, collapsed, toggleCollapsed } = useSidebarState();
  const router = useRouter();
  // Shared with useMessages: on the messages page the count arrives over SSE and
  // the badge follows it directly; elsewhere the layout polls for it.
  const { unreadCount, hasLiveSource } = useUnreadCount();
  const [askOpen, setAskOpen] = useState(false);
  const cmdkRef = useRef<() => void>(null);
  const mobileDrawerRef = useRef<HTMLDivElement>(null);

  // Global catch-all for stale step-up tokens. When a destructive API
  // call returns 401 STEP_UP_REQUIRED / INVALID / MISMATCH, the api
  // client throws StepUpRequiredError AND dispatches `step-up-required`
  // carrying a `retry` that replays the identical request with a fresh
  // token. We surface a modal here so a stale tab gets a clear re-prompt
  // instead of a confusing generic "Authentication required" toast — and
  // then FINISH THE ACTION. Re-verifying and doing nothing left the person
  // to guess which control had failed; the refusal happened before the
  // server acted, so replaying it is safe.
  const [stepUpFallback, setStepUpFallback] = useState<{
    message: string;
    code: string;
    retry?: (stepUpToken: string) => Promise<unknown>;
  } | null>(null);
  const [resuming, setResuming] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        message?: string;
        code?: string;
        retry?: (stepUpToken: string) => Promise<unknown>;
      };
      setStepUpFallback({
        message: detail?.message || 'Step-up confirmation required',
        code: detail?.code || 'STEP_UP_REQUIRED',
        ...(detail?.retry ? { retry: detail.retry } : {}),
      });
    };
    window.addEventListener('step-up-required', handler);
    return () => window.removeEventListener('step-up-required', handler);
  }, []);

  /** Re-run the refused request with the fresh token, and say how it went. */
  const resumeStepUpAction = async (stepUpToken: string) => {
    const retry = stepUpFallback?.retry;
    if (!retry) return; // The dialog has already said it can't be resumed.
    setResuming(true);
    try {
      await retry(stepUpToken);
      toast.success('Confirmed — the action completed.');
    } catch (err) {
      // Including a SECOND step-up refusal, which re-opens this dialog through
      // the same event; showing the server's wording beats inventing one.
      toast.error(formatError(err, 'The action could not be completed. Try it again.'));
    } finally {
      setResuming(false);
    }
  };

  // Global catch-all for an MFA refusal (#8). A route answered 401 MFA_REQUIRED
  // (the session is single-factor) or REAUTH_REQUIRED (it is strong but stale).
  // Neither is an expired session, so the api client neither refreshes nor signs
  // the person out — it dispatches `mfa-required` and we explain what happened
  // and point at enrolment. Without this the request would surface as a bare
  // "Unauthorized" toast on a session that is, in every other respect, fine.
  const [mfaPrompt, setMfaPrompt] = useState<{ message: string; code: string } | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message?: string; code?: string };
      setMfaPrompt({
        message: detail?.message || 'This action requires two-factor authentication',
        code: detail?.code || 'MFA_REQUIRED',
      });
    };
    window.addEventListener('mfa-required', handler);
    return () => window.removeEventListener('mfa-required', handler);
  }, []);

  usePolling(pollUnreadCount, POLL_INTERVAL, { enabled: !hasLiveSource });

  // Mobile drawer: a fixed overlay with no native dialog semantics, so it gets
  // the same shared overlay behaviour as Modal/SideDrawer — focus moves in, Tab
  // stays inside, Escape closes, the page behind can't scroll, and focus returns
  // to the hamburger on close.
  useDialogBehavior({ panelRef: mobileDrawerRef, onClose: closeMobile, active: mobileOpen });

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
      <div className="min-h-screen bg-canvas transition-colors flex">
        {/* Skip link — first tab stop; jumps keyboard/AT users past the nav
            straight to page content. Visually hidden until focused. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[60] focus:px-3 focus:py-2 focus:rounded-lg focus:bg-brand focus:text-white focus:shadow-lg"
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
                  className="absolute top-4 right-[-44px] p-2 rounded-lg bg-surface/90 text-fg-muted hover:text-fg shadow-lg"
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
          {/* Slim top bar + impersonation banner: ONE sticky stack, so the
              banner rides under the header instead of both pinning to top:0
              and overlapping on scroll. */}
          <div className="sticky top-0 z-30">
          <header className="bg-surface/80 backdrop-blur-md border-b border-default shadow-[0_8px_24px_rgba(15,23,42,0.06)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
            <div className="px-4 sm:px-6 lg:px-8 py-3 flex justify-between items-center gap-2">
              {/* min-w-0 + flex-1 let the org pill and title shrink (truncate)
                  on a phone rather than push the right-hand controls off-screen. */}
              <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
                <button
                  onClick={toggleMobile}
                  className="lg:hidden shrink-0 p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors"
                  aria-label="Open menu"
                >
                  <Menu className="w-5 h-5" />
                </button>
                {/* Organization / team context — top-left anchor, visible on
                    every page. Becomes an interactive switcher at 2+ orgs. */}
                <OrgSwitcher variant="header" className="min-w-0 shrink" />
                <div className="hidden sm:block h-8 w-px bg-gray-200 dark:bg-gray-700" aria-hidden />
                <div className="min-w-0">
                  {breadcrumbs && <Breadcrumb items={breadcrumbs} />}
                  <div className="flex items-center gap-3 min-w-0">
                    <h1 className="h1 truncate">{title}</h1>
                    {titleExtra}
                  </div>
                  {subtitle && (
                    <p className="mt-0.5 text-xs text-fg-muted truncate">
                      {subtitle}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 sm:gap-3 shrink-0">
                {/* Search / command palette (⌘K) — icon button; the shortcut
                    lives in the tooltip rather than a hard-to-see kbd chip. */}
                <button
                  onClick={() => cmdkRef.current?.()}
                  aria-label="Open command palette"
                  title="Search & commands (⌘K)"
                  className="p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors"
                >
                  <Search className="w-5 h-5" />
                </button>
                {/* Notification bell — global unread-messages indicator. Mirrors
                    the Messages sidebar badge but stays visible on every page
                    (and when the sidebar is collapsed). */}
                <Link
                  href="/dashboard/messages"
                  aria-label={unreadCount > 0 ? `Messages — ${unreadCount} unread` : 'Messages'}
                  className="relative p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors"
                >
                  <Bell className="w-5 h-5" />
                  {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-2xs font-bold text-white bg-red-500 rounded-full">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </Link>
                {/* Ask — the platform assistant. Replaces the old Help icon; the
                    full help reference is one click away inside the panel. The one
                    colored (brand-blue) call-to-action in the otherwise-neutral
                    topbar. Gated on the ai_generation entitlement (the ask service
                    enforces it too). Without it the entry stays visible but
                    locked, leading to the plan that includes it — hiding it left
                    people unaware the assistant exists. */}
                {askGate.entitled ? (
                  <button
                    onClick={() => setAskOpen(true)}
                    aria-label="Ask"
                    title="Ask the platform assistant"
                    className="p-1.5 rounded-full transition-colors"
                    style={{ color: 'var(--pb-brand)', background: 'color-mix(in srgb, var(--pb-brand) 12%, transparent)' }}
                  >
                    <Sparkles className="w-5 h-5" />
                  </button>
                ) : (
                  <FeatureLockedAction flag="ai_generation" label="Ask" icon={Sparkles} iconOnly />
                )}
                {actions}
              </div>
            </div>
          </header>
          <ImpersonationBanner />
          </div>
          <AuthErrorBanner />
          <MfaRequiredBanner />
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
            obtains one and then RESUMES the refused request, so the click
            that started this finishes. A dispatch without a `retry` (the
            SSE stream path, which cannot be replayed into its consumer)
            says so in the dialog rather than closing on a silent no-op.
            STEP_UP_METHOD_REQUIRED means the route accepts only a SECOND
            FACTOR, so the modal hides the password and provider options. */}
        {stepUpFallback && (
          <StepUpModal
            action={stepUpFallback.retry
              ? `Confirm to finish what you started. ${stepUpFallback.message}`
              : `Re-confirm to retry. ${stepUpFallback.message}`}
            details={stepUpFallback.retry ? (
              <p>Confirming here completes the action you just tried — you don&apos;t have to find it again.</p>
            ) : (
              <p>
                This one can&apos;t be resumed automatically: confirming here refreshes your
                verification, then start the action again from where you were.
              </p>
            )}
            requireStrongFactor={stepUpFallback.code === 'STEP_UP_METHOD_REQUIRED'}
            onConfirmed={resumeStepUpAction}
            onClose={() => { if (!resuming) setStepUpFallback(null); }}
          />
        )}

        {/* Global MFA refusal (#8) — explains the 401 and routes to enrolment
            instead of leaving a bare "Unauthorized" toast on a live session. */}
        {mfaPrompt && (
          <MfaRequiredDialog
            code={mfaPrompt.code}
            message={mfaPrompt.message}
            onClose={() => setMfaPrompt(null)}
          />
        )}

        {/* Ask agent panel — read-only, streaming, grounded in docs. */}
        {askOpen && <AskPanel onClose={() => setAskOpen(false)} />}
      </div>
    </>
  );
}
