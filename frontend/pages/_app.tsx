import type { AppProps } from 'next/app';
import type { NextPage } from 'next';
import type { ReactElement, ReactNode } from 'react';
import { AuthProvider } from '@/hooks/useAuth';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import '@/styles/globals.css';

export type NextPageWithLayout<P = object, IP = P> = NextPage<P, IP> & {
  getLayout?: (page: ReactElement) => ReactNode;
};

type AppPropsWithLayout = AppProps & {
  Component: NextPageWithLayout;
};

export default function App({ Component, pageProps }: AppPropsWithLayout) {
  const getLayout = Component.getLayout ?? ((page) => page);

  return (
    <ErrorBoundary>
      <AuthProvider>
        {getLayout(<Component {...pageProps} />)}
      </AuthProvider>
    </ErrorBoundary>
  );
}
