import type { AppContext, AppProps } from 'next/app';
import type { NextPage } from 'next';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import { MotionConfig } from 'framer-motion';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { FeaturesProvider } from '@/hooks/useFeatures';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { IdleSessionGuard } from '@/components/auth/IdleSessionGuard';
import { ToastProvider } from '@/components/ui/Toast';
import { initClientErrorReporting } from '@/lib/error-reporter';
import { initWebVitals } from '@/lib/telemetry/web-vitals';
import api from '@/lib/api';
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
  // The user is part of the key as well: an impersonation starts IN PLACE (its
  // token is memory-only, so it cannot ride a reload), and nothing rendered for
  // the operator — the layout included — may survive into the other person's
  // view, even when both are in the same org.
  const identity = user ? `${user.id}:${user.organizationId ?? ''}` : null;
  // Remount on a SWITCH between identities (org switch, impersonation start/stop,
  // sign-out) — never on the session first loading. Keying on the raw identity
  // remounted the whole tree the moment a full page load's session arrived
  // (anon → user), which killed work pages started on mount: returning from
  // Stripe Checkout, `useCheckoutReturn` began polling for the activated
  // subscription, the remount dropped it, and the `?checkout=` param was already
  // gone, so nothing restarted it — a late webhook left the buyer with no
  // subscription until a manual reload.
  const [seen, setSeen] = useState<{ identity: string | null; epoch: number }>({ identity, epoch: 0 });
  if (identity !== seen.identity) {
    // The first identity after "no session yet" is the initial load, not a switch.
    setSeen({ identity, epoch: seen.identity === null ? seen.epoch : seen.epoch + 1 });
  }
  const orgKey = `shell-${seen.epoch}`;
  // The FIRST page renders at full opacity, so server-rendered HTML is visible
  // before (or without) hydration — the public plugin directory must read with
  // JavaScript off. Once the identity has switched, each newly keyed shell fades in.
  const switched = seen.epoch > 0;

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

  // The route PATTERN the document loaded on (`/dashboard/pipelines/[id]`, never
  // the concrete path): web vitals measure that load, so they carry its label.
  const loadRoute = useRef(pathname);

  // Install global handlers for async/unhandled-rejection faults the React
  // error boundary can't catch, and start real-user monitoring (web vitals and
  // error-boundary counts to ops-center). Once, client-side only.
  useEffect(() => {
    initClientErrorReporting();
    initWebVitals(loadRoute.current, { send: (samples) => api.sendClientTelemetry(samples) });
  }, []);

  return (
    // `reducedMotion="user"` makes EVERY framer-motion component in the app
    // (toasts, drawers, the command palette, table rows, tooltips) honour the
    // OS "reduce motion" setting — transform/scale animations resolve instantly
    // while opacity still cross-fades. CSS keyframes/transitions are handled by
    // the matching media block in globals.css.
    // The animation FEATURES are not loaded here: see MotionFeatures
    // (src/components/ui/MotionFeatures.tsx), mounted by the shells that animate.
    <MotionConfig reducedMotion="user">
    <ErrorBoundary boundary="app" route={pathname}>
      <AuthProvider deferInit={publicPage}>
        <ToastProvider>
          {publicPage ? page : (
            <FeaturesProvider>
              <AnimatedPageShell>{page}</AnimatedPageShell>
            </FeaturesProvider>
          )}
          {/* Inactivity warning + sign-out for every signed-in page, public
              directory included — outside the page shell, so an org switch's
              remount never resets its timers. */}
          <IdleSessionGuard />
        </ToastProvider>
      </AuthProvider>
    </ErrorBoundary>
    </MotionConfig>
  );
}

/**
 * Present only to opt every page out of Automatic Static Optimization.
 *
 * The CSP allows scripts by a per-request nonce (src/lib/csp.ts, proxy.ts), and a
 * nonce can only be stamped on HTML rendered for the request that minted it. A
 * statically prerendered page is served from build-time HTML whose scripts carry
 * no nonce, so under `'strict-dynamic'` none of them would run — the page would
 * never hydrate. An `App.getInitialProps` makes Next server-render every page per
 * request instead. It adds nothing to the props; on client-side navigation it
 * runs in the browser and costs one function call.
 *
 * The prerendered 404/500 error pages stay static (Next always prerenders them);
 * they are plain server-rendered text and read fine without hydrating.
 */
// What `next/app`'s own `App.getInitialProps` does, without importing its runtime.
App.getInitialProps = async ({ Component, ctx }: AppContext) => ({
  pageProps: Component.getInitialProps ? await Component.getInitialProps(ctx) : {},
});
