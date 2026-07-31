import type { AppProps } from 'next/app';
import type { NextPage } from 'next';
import { useEffect, type ReactElement, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import { AnimatePresence, motion } from 'framer-motion';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { FeaturesProvider } from '@/hooks/useFeatures';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/components/ui/Toast';
import { initClientErrorReporting } from '@/lib/error-reporter';
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
 * Page shell that keys the animated wrapper on BOTH the route and the active
 * org. Re-keying on `user.organizationId` means switching orgs remounts the page
 * subtree, so every data hook (useListPage / useFetch / reports, etc.) refetches
 * under the new org. Without this, an in-place org switch changes the API
 * client's `x-org-id` header but doesn't re-run the list effects (their deps
 * don't include the org), so pages kept showing the PREVIOUS org's rows —
 * including its private data — until the user changed a filter, and row actions
 * fired with a mismatched org context. Must live inside AuthProvider to read
 * useAuth. Remount also resets transient page state on switch, which is correct.
 */
function AnimatedPageShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user } = useAuth();
  const orgKey = user?.organizationId ?? 'anon';

  return (
    // Opacity-only — do NOT add x/y/scale here. framer-motion writes those as an
    // inline `transform`, and any non-none transform makes this page-wrapping div
    // a containing block for position:fixed descendants, which traps every
    // modal's `fixed inset-0` backdrop inside the page box instead of the
    // viewport (clipped/offset modals). The upward page-reveal motion is handled
    // by the `.page-reveal` class on each page's <main>.
    <AnimatePresence mode="wait">
      <motion.div
        key={`${router.pathname}:${orgKey}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2, ease: 'easeInOut' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/** Next.js app wrapper. Provides auth, config, error boundary, and animated page transitions. */
export default function App({ Component, pageProps }: AppPropsWithLayout) {
  const getLayout = Component.getLayout ?? ((page) => page);

  // Install global handlers for async/unhandled-rejection faults the React
  // error boundary can't catch. Once, client-side only.
  useEffect(() => { initClientErrorReporting(); }, []);

  return (
    <ErrorBoundary>
      <AuthProvider>
        <FeaturesProvider>
          <ToastProvider>
            <AnimatedPageShell>
              {getLayout(<Component {...pageProps} />)}
            </AnimatedPageShell>
          </ToastProvider>
        </FeaturesProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
