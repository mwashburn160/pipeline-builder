import { useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useAuth } from '@/hooks/useAuth';
import { LoadingPage } from '@/components/ui/Loading';
import LandingPage from '@/components/landing/LandingPage';
import { siteUrlServerSideProps, DEFAULT_SITE_URL, type WithSiteUrl } from '@/lib/site-url';

/**
 * Landing page for guests, dashboard redirect for authenticated users.
 *
 * `siteUrl` comes from {@link siteUrlServerSideProps} (runtime `APP_SITE_URL`).
 * The OG `<Head>` is rendered UNCONDITIONALLY — the auth state only picks the
 * body (landing vs. loader). Gating the `<Head>` behind the auth-loading check
 * (as it was) hid it from the server-rendered HTML, since `isInitialized` is
 * `false` on the server, so social scrapers never saw the card.
 */
export default function Home({ siteUrl = DEFAULT_SITE_URL }: Partial<WithSiteUrl>) {
  const router = useRouter();
  const { isAuthenticated, isLoading, isInitialized } = useAuth();
  const ogImage = `${siteUrl}/og-image.png`;

  useEffect(() => {
    if (isInitialized && !isLoading && isAuthenticated) {
      router.push('/dashboard');
    }
  }, [isAuthenticated, isLoading, isInitialized, router]);

  // Guests see the landing page; while auth initializes, or for an authenticated
  // user about to be redirected, show the loader.
  const showLanding = isInitialized && !isLoading && !isAuthenticated;

  return (
    <>
      <Head>
        <title>Pipeline Builder — Production-Ready CI/CD from TypeScript, CLI, or AI</title>
        <meta name="description" content="Turn plugin definitions and pipeline configs into fully deployed AWS CodePipeline infrastructure — inside your AWS account with zero lock-in. 125 plugins, compliance engine, multi-tenant orgs." />
        <meta property="og:title" content="Pipeline Builder — Production-Ready CI/CD from TypeScript, CLI, or AI" />
        <meta property="og:description" content="Self-service CI/CD pipelines with AI generation, 125 plugins, per-org compliance, and execution analytics. Deploys as native AWS CodePipeline in your account." />
        <meta property="og:type" content="website" />
        <meta property="og:image" content={ogImage} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:alt" content="Pipeline Builder — Self-Service CI/CD for AWS" />
        <meta property="og:url" content={siteUrl} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Pipeline Builder" />
        <meta name="twitter:description" content="Production-ready AWS CodePipelines from TypeScript, CLI, or a single AI prompt." />
        <meta name="twitter:image" content={ogImage} />
      </Head>
      {showLanding ? <LandingPage /> : <LoadingPage message="Loading..." />}
    </>
  );
}

export const getServerSideProps = siteUrlServerSideProps;
