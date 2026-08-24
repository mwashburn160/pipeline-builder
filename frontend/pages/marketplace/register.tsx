import { useState, useEffect, useCallback } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import type { IncomingMessage } from 'http';
import { ShoppingBag } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/Toast';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { stashMarketplaceRef, readMarketplaceRef, clearMarketplaceRef } from '@/hooks/usePendingMarketplaceClaim';

/** Read the raw request body (Next doesn't parse it for page requests). */
function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

interface Props {
  /** The AWS Marketplace registration token captured from the POST redirect, if any. */
  token: string | null;
}

/**
 * AWS Marketplace fulfillment (registration) URL target.
 *
 * AWS **POSTs** here (application/x-www-form-urlencoded) with an
 * `x-amzn-marketplace-token` after a customer subscribes. We capture the token
 * server-side, then RESOLVE it client-side (the resolve endpoint is public) to
 * get a single-use `registrationRef`, and finally CLAIM it against the signed-in
 * user's organization. A brand-new purchaser signs up first; the ref rides
 * through auth in sessionStorage and is claimed on the dashboard.
 */
export const getServerSideProps: GetServerSideProps<Props> = async ({ req, query }) => {
  let token: string | null = null;
  if (req.method === 'POST') {
    const raw = await readRawBody(req);
    const params = new URLSearchParams(raw);
    token = params.get('x-amzn-marketplace-token') || params.get('token');
  } else if (typeof query.token === 'string') {
    token = query.token;
  }
  return { props: { token } };
};

type Phase = 'resolving' | 'pending' | 'already' | 'error' | 'claiming';

export default function MarketplaceRegisterPage({ token }: Props) {
  const router = useRouter();
  const toast = useToast();
  const { user, isAuthenticated, isInitialized } = useAuth();

  const [phase, setPhase] = useState<Phase>('resolving');
  const [registrationRef, setRegistrationRef] = useState<string | null>(null);
  const [planName, setPlanName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resolve the AWS token (or pick up a ref stashed before an auth hop).
  useEffect(() => {
    let cancelled = false;

    if (!token) {
      // No fresh token — maybe we returned from an auth hop with a stashed ref.
      const stashed = readMarketplaceRef();
      if (stashed) {
        setRegistrationRef(stashed.registrationRef);
        setPlanName(stashed.planName);
        setPhase('pending');
      } else {
        setPhase('error');
        setError('No AWS Marketplace registration token was provided. Start from your AWS Marketplace subscription.');
      }
      return;
    }

    api.resolveMarketplace(token)
      .then((res) => {
        if (cancelled) return;
        if (!res.success || !res.data) { setPhase('error'); setError(res.message || 'Could not resolve your AWS Marketplace subscription.'); return; }
        if (res.data.alreadyRegistered) { setPhase('already'); return; }
        const ref = res.data.registrationRef ?? null;
        const name = res.data.planName ?? null;
        // A pending result with no ref is unusable — treat as an error rather than
        // rendering a "Link" button whose handler silently no-ops.
        if (!ref) {
          setPhase('error');
          setError('Your AWS Marketplace registration could not be prepared. Re-launch from AWS Marketplace.');
          return;
        }
        setRegistrationRef(ref);
        setPlanName(name);
        // Persist across the sign-up/sign-in hop (sessionStorage + cookie fallback
        // so a storage-blocked browser doesn't lose the linkage silently).
        stashMarketplaceRef(ref, name);
        setPhase('pending');
      })
      .catch((e) => { if (!cancelled) { setPhase('error'); setError(formatError(e)); } });

    return () => { cancelled = true; };
  }, [token]);

  const claim = useCallback(async () => {
    if (!registrationRef) return;
    setPhase('claiming');
    setError(null);
    try {
      const res = await api.claimMarketplaceRegistration(registrationRef);
      if (!res.success) throw new Error(res.message || 'Could not link your subscription.');
      clearMarketplaceRef();
      toast.success('AWS Marketplace subscription linked');
      router.replace('/dashboard/billing');
    } catch (e) {
      setPhase('pending');
      setError(formatError(e));
    }
  }, [registrationRef, router, toast]);

  // Send an unauthenticated purchaser to sign up / sign in; the ref is already
  // stashed, so the dashboard claims it automatically once they're in.
  const goAuth = (path: string) => router.push(path);

  const body = () => {
    if (phase === 'resolving' || !isInitialized) {
      return <div className="flex items-center gap-2 text-sm text-[var(--pb-text-muted)] py-4"><LoadingSpinner size="sm" /> Verifying your AWS Marketplace subscription…</div>;
    }
    if (phase === 'error') {
      return (
        <>
          <ErrorAlert message={error ?? 'Something went wrong.'} />
          <p className="text-sm text-[var(--pb-text-muted)] mt-3">Return to your AWS Marketplace subscription and click <strong>Set up your account</strong> again to get a fresh link.</p>
        </>
      );
    }
    if (phase === 'already') {
      return (
        <>
          <p className="text-sm text-[var(--pb-text-muted)]">This AWS Marketplace subscription is already linked to an organization.</p>
          <Link href="/" className="inline-block mt-4"><Button>Sign in</Button></Link>
        </>
      );
    }
    // pending / claiming
    const planLabel = planName ? <strong>{planName}</strong> : 'your plan';
    if (isAuthenticated && user) {
      return (
        <>
          <p className="text-sm text-[var(--pb-text-muted)]">
            Link your AWS Marketplace {planLabel} subscription to{' '}
            <strong>{user.organizationName || 'your organization'}</strong>. Billing is handled by AWS — nothing to enter here.
          </p>
          {error && <div className="mt-3"><ErrorAlert message={error} /></div>}
          <Button className="mt-4" disabled={phase === 'claiming'} onClick={() => void claim()}>
            {phase === 'claiming' ? <><LoadingSpinner size="sm" className="mr-2" /> Linking…</> : `Link to ${user.organizationName || 'my organization'}`}
          </Button>
        </>
      );
    }
    return (
      <>
        <p className="text-sm text-[var(--pb-text-muted)]">
          Your AWS Marketplace {planLabel} subscription is ready. Create your Pipeline Builder account
          (or sign in) to finish linking it — we&apos;ll connect it automatically once you&apos;re in.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={() => goAuth('/auth/register')}>Create account</Button>
          <Button variant="secondary" onClick={() => goAuth('/')}>Sign in</Button>
        </div>
      </>
    );
  };

  if (!isInitialized && phase === 'resolving') return <LoadingPage />;

  return (
    <>
      <Head><title>AWS Marketplace — Finish setup</title></Head>
      <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-[var(--pb-bg)]">
        <Card className="w-full max-w-md p-6">
          <div className="flex items-center gap-2 mb-1">
            <ShoppingBag className="w-5 h-5 text-[var(--pb-brand)]" />
            <h1 className="text-xl font-bold">Finish your AWS Marketplace setup</h1>
          </div>
          <div className="mt-4">{body()}</div>
        </Card>
      </div>
    </>
  );
}
