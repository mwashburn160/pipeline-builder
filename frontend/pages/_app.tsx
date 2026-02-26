import type { AppProps } from 'next/app';
import type { NextPage } from 'next';
import type { ReactElement, ReactNode } from 'react';
import { useRouter } from 'next/router';
import { AnimatePresence, motion } from 'framer-motion';
import { AuthProvider } from '@/hooks/useAuth';
import { ConfigProvider } from '@/hooks/useConfig';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import '@/styles/globals.css';

/** Next.js page type extended with an optional per-page layout function. */
export type NextPageWithLayout<P = object, IP = P> = NextPage<P, IP> & {
  getLayout?: (page: ReactElement) => ReactNode;
};

/** AppProps augmented with the per-page layout component type. */
type AppPropsWithLayout = AppProps & {
  Component: NextPageWithLayout;
};

/** Next.js app wrapper. Provides auth, config, error boundary, and animated page transitions. */
export default function App({ Component, pageProps }: AppPropsWithLayout) {
  const router = useRouter();
  const getLayout = Component.getLayout ?? ((page) => page);

  return (
    <ErrorBoundary>
      <ConfigProvider>
      <AuthProvider>
        <AnimatePresence mode="wait">
          <motion.div
            key={router.pathname}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
          >
            {getLayout(<Component {...pageProps} />)}
          </motion.div>
        </AnimatePresence>
      </AuthProvider>
      </ConfigProvider>
    </ErrorBoundary>
  );
}
