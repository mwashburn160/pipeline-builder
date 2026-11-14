import type { AppProps } from 'next/app';
import type { NextPage } from 'next';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import { MotionConfig } from 'framer-motion';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { FeaturesProvider } from '@/hooks/useFeatures';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/components/ui/Toast';
import { initClientErrorReporting } from '@/lib/error-reporter';
import { isPublicDirectoryRoute } from '@/lib/public-directory/routes';
import '@/styles/globals.css';

/** Next.js page type extended with an optional per-page layout function. */
export type NextPageWithLayout<P = object, IP = P> = NextPage<P, IP> & {
  getLayout?: (page: ReactElement) => ReactNode;
};

/** AppProps augmented with the per-page layout component type. */
type AppPropsWithLayout = AppProps & {
  Component: NextPageWithLayout;
};

/**
 * Page shell keyed on the active ORG — and deliberately not on the route.
 *
 * Re-keying on `user.organizationId` means switching orgs remounts the page
 * subtree, so every data hook (useListPage / useFetch / reports, etc.) refetches
 * under the new org. Without this, an in-place org switch changes the API
 * client's `x-org-id` header but doesn't re-run the list effects (their deps
 * don't include the org), so pages kept showing the PREVIOUS org's rows —
 * including its private data — until the user changed a filter, and row actions
 * fired with a mismatched org context. Must live inside AuthProvider to read
 * useAuth. Remount also resets transient page state on switch, which is correct:
 * an org is a tenant boundary and everything behind it should be dropped
 * (`AuthProvider` clears the shared query cache on the same switch).
 *
 * The route is NOT part of the key, and `mode="wait"` is gone. Keying on
 * `router.pathname` inside an exit-then-enter presence made every navigation —
 * back and forward included — hold the new page unmounted for the full 200ms
 * exit before a single one of its effects could run, so each route change paid
 * an animation delay AND re-fetched from zero. Next already swaps the page
 * component on navigation; the per-page entrance is the `.page-reveal` class on
 * each page's <main>, which costs nothing and doesn't serialise with anything.
 */
function AnimatedPageShell({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const orgKey = user?.organizationId ?? 'anon';
  // The FIRST page renders at full opacity, so server-rendered HTML is visible
  // before (or without) hydration — the public plugin directory must read with
  // JavaScript off. Once the org has changed, each newly keyed shell fades in.
  const [firstKey] = useState(orgKey);
  const [switched, setSwitched] = useState(false);
  if (!switched && orgKey !== firstKey) setSwitched(true);

  // A CSS fade rather than framer-motion: this one opacity transition was the
  // only `motion` component in the `_app` bundle, and `motion` pulls in its whole
  // feature set (~49 KB gzip) on every route. `.org-switch-fade` is opacity-only
  // — no transform, which would make this page-wrapping div a containing block
  // for position:fixed descendants and trap every modal backdrop inside it — and
  // the reduced-motion block in globals.css collapses it like every other
  // animation.
  return (
    <div key={orgKey} className={switched ? 'org-switch-fade' : undefined}>
      {children}
    </div>
  );
}

/** Next.js app wrapper. Provides auth, config, error boundary, and animated page transitions. */
export default function App({ Component, pageProps }: AppPropsWithLayout) {
  const getLayout = Component.getLayout ?? ((page) => page);
  // Public directory pages get the light shell: no `/api/config` round trip
  // (FeaturesProvider — nothing on them reads a feature flag; `useFeatures`
  // falls back to its default context) and no page-level motion wrapper, and
  // the session restore waits until the browser is idle rather than competing
  // with hydration. AuthProvider and ToastProvider stay at the SAME position in
  // both trees, so navigating between public and app pages never remounts the
  // session.
  const { pathname } = useRouter();
  const publicPage = isPublicDirectoryRoute(pathname);
  const page = getLayout(<Component {...pageProps} />);

  // Install global handlers for async/unhandled-rejection faults the React
  // error boundary can't catch. Once, client-side only.
  useEffect(() => { initClientErrorReporting(); }, []);

  return (
    // `reducedMotion="user"` makes EVERY framer-motion component in the app
    // (toasts, drawers, the command palette, table rows, tooltips) honour the
    // OS "reduce motion" setting — transform/scale animations resolve instantly
    // while opacity still cross-fades. CSS keyframes/transitions are handled by
    // the matching media block in globals.css.
    <MotionConfig reducedMotion="user">
    <ErrorBoundary>
      <AuthProvider deferInit={publicPage}>
        <ToastProvider>
          {publicPage ? page : (
            <FeaturesProvider>
              <AnimatedPageShell>{page}</AnimatedPageShell>
            </FeaturesProvider>
          )}
        </ToastProvider>
      </AuthProvider>
    </ErrorBoundary>
    </MotionConfig>
  );
}
