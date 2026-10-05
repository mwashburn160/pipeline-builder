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
import { resolveRegistrationToken, type ResolveOutcome } from '@/lib/marketplace/resolve';

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
  /** The result of exchanging the POSTed token, server-side. Never the token
   *  itself: it stays on the server, so it is absent from the HTML, the
   *  hydration payload, the back/forward cache and view-source. */
  outcome: ResolveOutcome | null;
}

/**
 * AWS Marketplace fulfillment (registration) URL target.
 *
 * AWS **POSTs** here (application/x-www-form-urlencoded) with an
 * `x-amzn-marketplace-token` after a customer subscribes. The token is captured
 * AND exchanged server-side, so it never reaches the browser; the page ships
 * only the opaque single-use `registrationRef`, which is then CLAIMED against
 * the signed-in user's organization. A brand-new purchaser signs up first; the
 * ref rides through auth in sessionStorage and is claimed on the dashboard.
 */
export const getServerSideProps: GetServerSideProps<Props> = async ({ req }) => {
  let token: string | null = null;
  if (req.method === 'POST') {
    const raw = await readRawBody(req);
    const params = new URLSearchParams(raw);
    token = params.get('x-amzn-marketplace-token') || params.get('token');
  }
  // No `?token=` fallback. AWS always POSTs the fulfillment form, so a query
  // parameter only ever served hand-testing — and it put a live, resolvable
  // registration token somewhere it is written down: nginx logs `"$request"`
  // (the full request line, query string included) on every deploy target, and
  // the browser sends it on as the Referer of any outbound link from this page.
  // A GET now lands on the no-token branch, which says to start again from AWS.

  // Exchanged HERE rather than from the browser, so the AWS token never leaves
  // the server. The page ships only the opaque registrationRef — which has to
  // reach the client regardless, to survive the sign-up hop.
  const outcome = token ? await resolveRegistrationToken(token) : null;
  return { props: { outcome } };
};

type Phase = 'resolving' | 'pending' | 'already' | 'error' | 'claiming';

export default function MarketplaceRegisterPage({ outcome }: Props) {
  const router = useRouter();
  const toast = useToast();
  const { user, isAuthenticated, isInitialized } = useAuth();

  // Seeded straight from the server's answer rather than fetched on mount. The
  // initialisers run identically on both sides of hydration, so there is no
  // "Verifying…" flash for a buyer whose token was already exchanged — and
  // `resolving` now means only "we have nothing yet and must look in storage".
  const [phase, setPhase] = useState<Phase>(
    outcome ? (outcome.state === 'pending' ? 'pending' : outcome.state) : 'resolving',
  );
  const [registrationRef, setRegistrationRef] = useState<string | null>(
    outcome?.state === 'pending' ? outcome.registrationRef : null,
  );
  const [planName, setPlanName] = useState<string | null>(
    outcome?.state === 'pending' ? outcome.planName : null,
  );
  const [error, setError] = useState<string | null>(
    outcome?.state === 'error' ? outcome.message : null,
  );

  useEffect(() => {
    // Persist across the sign-up / sign-in hop (sessionStorage + cookie fallback,
    // so a storage-blocked browser doesn't lose the linkage silently). It has to
    // happen client-side: there is no storage to write to during the render that
    // produced it.
    if (outcome?.state === 'pending') {
      stashMarketplaceRef(outcome.registrationRef, outcome.planName);
      return;
    }
    // `already` and `error` are terminal — the server has spoken.
    if (outcome) return;

    // No token on this request. Either the buyer came back from an auth hop with
    // a ref already stashed, or they reached the page some other way.
    const stashed = readMarketplaceRef();
    if (stashed) {
      setRegistrationRef(stashed.registrationRef);
      setPlanName(stashed.planName);
      setPhase('pending');
    } else {
      setPhase('error');
      setError('No AWS Marketplace registration token was provided. Start from your AWS Marketplace subscription.');
    }
  }, [outcome]);

  const claim = useCallback(async () => {
    if (!registrationRef) return;
    setPhase('claiming');
    setError(null);
    try {
      const res = await api.claimMarketplaceRegistration(registrationRef);
      if (!res.success) throw new Error(res.message || 'Could not link your subscription.');
      clearMarketplaceRef();
      toast.success('AWS Marketplace subscription linked');
      void router.replace('/dashboard/billing');
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
      return <div className="flex items-center gap-2 text-sm text-fg-muted py-4"><LoadingSpinner size="sm" /> Verifying your AWS Marketplace subscription…</div>;
    }
    if (phase === 'error') {
      return (
        <>
          <ErrorAlert message={error ?? 'Something went wrong.'} />
          <p className="text-sm text-fg-muted mt-3">Return to your AWS Marketplace subscription and click <strong>Set up your account</strong> again to get a fresh link.</p>
        </>
      );
    }
    if (phase === 'already') {
      return (
        <>
          <p className="text-sm text-fg-muted">This AWS Marketplace subscription is already linked to an organization.</p>
          <Link href="/" className="inline-block mt-4"><Button>Sign in</Button></Link>
        </>
      );
    }
    // pending / claiming
    const planLabel = planName ? <strong>{planName}</strong> : 'your plan';
    if (isAuthenticated && user) {
      return (
        <>
          <p className="text-sm text-fg-muted">
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
        <p className="text-sm text-fg-muted">
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
      <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-canvas">
        <Card className="w-full max-w-md p-6">
          <div className="flex items-center gap-2 mb-1">
            <ShoppingBag className="w-5 h-5 text-brand" />
            <h1 className="text-xl font-bold">Finish your AWS Marketplace setup</h1>
          </div>
          <div className="mt-4">{body()}</div>
        </Card>
      </div>
    </>
  );
}
