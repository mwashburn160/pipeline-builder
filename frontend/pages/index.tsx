import { useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useAuth } from '@/hooks/useAuth';
import { LoadingPage } from '@/components/ui/Loading';
import LandingPage from '@/components/landing/LandingPage';

/** Landing page for guests, dashboard redirect for authenticated users. */
export default function Home() {
  const router = useRouter();
  const { isAuthenticated, isLoading, isInitialized } = useAuth();

  useEffect(() => {
    if (isInitialized && !isLoading && isAuthenticated) {
      router.push('/dashboard');
    }
  }, [isAuthenticated, isLoading, isInitialized, router]);

  // Still loading auth state
  if (!isInitialized || isLoading) {
    return <LoadingPage message="Loading..." />;
  }

  // Authenticated — will redirect, show loading
  if (isAuthenticated) {
    return <LoadingPage message="Loading..." />;
  }

  // Guest — show landing page
  return (
    <>
      <Head>
        <title>Pipeline Builder — Production-Ready CI/CD from TypeScript, CLI, or AI</title>
        <meta name="description" content="Turn plugin definitions and pipeline configs into fully deployed AWS CodePipeline infrastructure — inside your AWS account with zero lock-in. 125 plugins, compliance engine, multi-tenant orgs." />
        <meta property="og:title" content="Pipeline Builder — Production-Ready CI/CD from TypeScript, CLI, or AI" />
        <meta property="og:description" content="Self-service CI/CD pipelines with AI generation, 125 plugins, per-org compliance, and execution analytics. Deploys as native AWS CodePipeline in your account." />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Pipeline Builder" />
        <meta name="twitter:description" content="Production-ready AWS CodePipelines from TypeScript, CLI, or a single AI prompt." />
      </Head>
      <LandingPage />
    </>
  );
}
