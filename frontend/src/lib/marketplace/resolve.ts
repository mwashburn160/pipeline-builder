// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only exchange of an AWS Marketplace registration token.
 *
 * This runs in `getServerSideProps` on the fulfillment page, never in the
 * browser, and it is the ONLY caller of the billing resolve route — nginx
 * returns 404 for it on every deploy target.
 *
 * Why it does not go through `API_URL` like the rest of SSR: that points at the
 * public gateway, so the route would have to stay publicly reachable, and the
 * gateway's rate limit would see the frontend pod's address rather than the
 * buyer's — putting every purchaser on the planet into one shared bucket. Going
 * straight to the service over the cluster network lets the route be closed to
 * the outside entirely, which beats throttling it.
 *
 * The token never reaches the browser. The page returns only the opaque
 * `registrationRef`, which is what the claim needs; the AWS token stays on this
 * side of the wire and is never logged, not even truncated.
 */

/** Upper bound on the exchange. The route makes two AWS calls (ResolveCustomer
 *  + GetEntitlements), so this is well above the happy path and well below a
 *  page request that a buyer would abandon. */
const RESOLVE_TIMEOUT_MS = 10_000;

/** What the fulfillment page knows after the exchange. Never carries the token. */
export type ResolveOutcome =
  /** Bound already — nothing to register, tell them to sign in. */
  | { state: 'already' }
  /** Resolved; `registrationRef` is single-use and short-lived. */
  | { state: 'pending'; registrationRef: string; planName: string | null }
  /** Anything else. `message` is shown to the buyer, so it must not leak internals. */
  | { state: 'error'; message: string };

interface ResolveBody {
  success?: boolean;
  message?: string;
  data?: { alreadyRegistered?: boolean; registrationRef?: string; planName?: string | null };
}

/**
 * Exchange the token for a pending registration.
 *
 * Never throws: a buyer who has just paid should see a page explaining what to
 * do, not a 500. Every failure becomes `state: 'error'` with wording that sends
 * them back to AWS for a fresh link, since the token is single-use and a retry
 * of the same one cannot succeed.
 */
export async function resolveRegistrationToken(token: string): Promise<ResolveOutcome> {
  const base = process.env.BILLING_INTERNAL_URL;
  if (!base) {
    // Deployment fault, not the buyer's. Loud in the logs, vague to them.
    console.error('[marketplace] BILLING_INTERNAL_URL is not set — cannot resolve a registration token');
    return { state: 'error', message: 'Marketplace registration is unavailable right now. Please try again shortly.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/billing/marketplace/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // The field name AWS uses. The route also accepts `token`, but naming it
      // the same on both hops keeps one spelling in play.
      body: JSON.stringify({ 'x-amzn-marketplace-token': token }),
      signal: controller.signal,
    });

    const body = (await res.json().catch(() => ({}))) as ResolveBody;

    if (!res.ok || body.success === false) {
      // The route's own message is written for the buyer (wrong product, no
      // token, provider unconfigured), so it is the most useful thing to show.
      console.error('[marketplace] resolve failed', { status: res.status, message: body.message });
      return {
        state: 'error',
        message: body.message || 'Could not verify your AWS Marketplace subscription.',
      };
    }

    if (body.data?.alreadyRegistered) return { state: 'already' };

    const registrationRef = body.data?.registrationRef;
    if (!registrationRef) {
      // A success with no ref is unusable — surface it rather than rendering a
      // "Link" button whose handler would silently no-op.
      console.error('[marketplace] resolve returned no registrationRef');
      return { state: 'error', message: 'Your AWS Marketplace registration could not be prepared. Re-launch from AWS Marketplace.' };
    }
    return { state: 'pending', registrationRef, planName: body.data?.planName ?? null };
  } catch (err) {
    // Timeout or network. Deliberately does not echo the error to the buyer.
    console.error('[marketplace] resolve threw', { error: err instanceof Error ? err.message : String(err) });
    return { state: 'error', message: 'Could not reach AWS Marketplace. Please try again shortly.' };
  } finally {
    clearTimeout(timer);
  }
}
