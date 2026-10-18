import { useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useAuth } from '@/hooks/useAuth';
import { takeReturnPath } from '@/lib/return-to';
import { LoadingPage } from '@/components/ui/Loading';
import LandingPage from '@/components/landing/LandingPage';
import { siteUrlServerSideProps, DEFAULT_SITE_URL, type WithSiteUrl } from '@/lib/site-url';

/**
 * Landing page for guests; authenticated users go to their return-to path
 * (see `@/lib/return-to` — sanitized, same-origin only) or the dashboard.
 *
 * `siteUrl` comes from {@link siteUrlServerSideProps} (runtime `APP_SITE_URL`).
 * The OG `<Head>` is rendered UNCONDITIONALLY — the auth state only picks the
 * body (landing vs. loader). Gating the `<Head>` behind the auth-loading check
 * (as it was) hid it from the server-rendered HTML, since `isInitialized` is
 * `false` on the server, so social scrapers never saw the card.
 */
export default function Home({ siteUrl = DEFAULT_SITE_URL }: Partial<WithSiteUrl>) {
  const router = useRouter();
  const { isAuthenticated, isLoading, isSubmitting, isInitialized } = useAuth();
  const ogImage = `${siteUrl}/og-image.png`;

  // A sign-in submitted from this page navigates by itself (to the return path,
  // or to passkey enrolment for a bootstrap administrator) — so while one is in
  // flight this redirect stands down rather than override that destination.
  useEffect(() => {
    if (isInitialized && !isLoading && !isSubmitting && isAuthenticated) {
      void router.push(takeReturnPath());
    }
  }, [isAuthenticated, isLoading, isSubmitting, isInitialized, router]);

  // Guests see the landing page; while auth initializes, or for an authenticated
  // user about to be redirected, show the loader. A sign-in SUBMISSION does not
  // count as loading: the card must stay mounted to show an MFA prompt, a
  // forced password change, or the error.
  const showLanding = isInitialized && !isLoading && (isSubmitting || !isAuthenticated);

  return (
    <>
      <Head>
        <title>Pipeline Builder — Software Factories on AWS</title>
        <meta name="description" content="Stand up a complete DevSecOps environment on AWS — secure delivery pipelines, a signed and SBOM-attested supply chain, policy-as-code compliance and a tamper-evident audit trail, inside your own AWS account with no lock-in." />
        <meta property="og:title" content="Pipeline Builder — Software Factories on AWS" />
        <meta property="og:description" content="A software factory on AWS: secure delivery pipelines with AI generation, 119 signed plugins, per-org compliance, and execution analytics. Deploys as native AWS CodePipeline in your account." />
        <meta property="og:type" content="website" />
        <meta property="og:image" content={ogImage} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:alt" content="Pipeline Builder — Software Factories on AWS" />
        <meta property="og:url" content={siteUrl} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Pipeline Builder" />
        <meta name="twitter:description" content="Complete DevSecOps environments on AWS — secure delivery, a proven supply chain, and governance built in." />
        <meta name="twitter:image" content={ogImage} />
      </Head>
      {showLanding ? <LandingPage /> : <LoadingPage message="Loading..." />}
    </>
  );
}

export const getServerSideProps = siteUrlServerSideProps;
