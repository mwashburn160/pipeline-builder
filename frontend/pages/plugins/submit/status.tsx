// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/plugins/submit/status?token=…` — a submission's status, reached from the
 * verify page or any submission email. The token is the status token (never
 * the one-time confirmation token), so reading it changes nothing. Polls while
 * the submission is still moving, shows the automated gates (id, pass/fail and
 * message only), the moderator's reason, and the listing once approved.
 */
import { useCallback, useState } from 'react';
import Link from 'next/link';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { PublicLayout } from '@/components/public-directory/PublicLayout';
import { TrustTierBadge } from '@/components/public-directory/TrustTierBadge';
import { SubmissionGateList } from '@/components/plugin-submissions/SubmissionChecks';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { RetryError } from '@/components/ui/RetryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePolling } from '@/hooks/usePolling';
import { ApiError } from '@/lib/api/errors';
import { getSubmissionStatus } from '@/lib/api/domains/plugin-submissions';
import {
  isSubmissionInFlight, SUBMISSION_STATUS_COLORS, SUBMISSION_STATUS_LABELS, SUBMISSION_STATUS_NEXT, tokenFromQuery,
} from '@/lib/plugin-submissions/status';
import { pluginPagePath } from '@/lib/public-directory/links';
import type { SubmissionStatusView } from '@/types/plugin-submissions';

/** How often an in-flight submission is re-read. */
const STATUS_POLL_MS = 15_000;

function statusErrorMessage(err: unknown): { message: string; retryable: boolean } {
  if (err instanceof ApiError) {
    if (err.code === 'SUBMISSIONS_DISABLED') return { message: 'Anonymous plugin submissions are not enabled on this instance.', retryable: false };
    if (err.statusCode === 400 || err.statusCode === 404) {
      return { message: 'No submission matches this status link. Check that you copied the whole link.', retryable: false };
    }
    return { message: err.message || 'Could not load the submission status.', retryable: true };
  }
  return { message: 'Could not reach the server. Check your connection and try again.', retryable: true };
}

export default function SubmissionStatusPage() {
  const router = useRouter();
  const token = router.isReady ? tokenFromQuery(router.query.token) : null;
  const [view, setView] = useState<SubmissionStatusView | null>(null);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const next = await getSubmissionStatus(token);
      setView(next);
      setError(null);
    } catch (err) {
      setError(statusErrorMessage(err));
    }
  }, [token]);

  const polling = !!token && !(error && !error.retryable) && (!view || isSubmissionInFlight(view.status));
  usePolling(load, STATUS_POLL_MS, { enabled: polling });

  const failedGates = view?.gates?.filter((g) => !g.ok) ?? [];

  return (
    <PublicLayout>
      <Head>
        <title>Plugin submission status · Pipeline Builder</title>
        <meta name="robots" content="noindex" />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-3xl font-bold text-fg">Plugin submission status</h1>

        {router.isReady && !token && (
          <Callout variant="warning" title="No status token">
            Open the status link from the confirmation page or one of our emails.
          </Callout>
        )}

        {error && !view && (error.retryable
          ? <RetryError message={error.message} onRetry={() => { void load(); }} />
          : <Callout variant="danger" title="Status unavailable"><span data-testid="status-error">{error.message}</span></Callout>)}

        {token && !view && !error && <Skeleton className="h-40 w-full" />}

        {view && (
          <div className="card space-y-4 p-6" data-testid="submission-status">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-mono text-lg font-semibold text-fg">community/{view.name}</h2>
                <span className="text-sm text-fg-muted">v{view.version}</span>
                <Badge color={SUBMISSION_STATUS_COLORS[view.status]}>{SUBMISSION_STATUS_LABELS[view.status]}</Badge>
              </div>
              <p className="text-sm text-fg-muted">{SUBMISSION_STATUS_NEXT[view.status]}</p>
              {isSubmissionInFlight(view.status) && (
                <p className="text-xs text-fg-subtle" aria-live="polite">This page refreshes on its own.</p>
              )}
            </div>

            {view.reason && (
              <Callout variant={view.status === 'rejected' || view.status === 'gate_failed' ? 'danger' : 'info'} title="Reason">
                <span data-testid="status-reason">{view.reason}</span>
              </Callout>
            )}

            {view.gates && view.gates.length > 0 && (
              <section className="space-y-2" aria-labelledby="gates-heading">
                <h3 id="gates-heading" className="text-sm font-semibold text-fg">
                  Automated checks{failedGates.length > 0 ? ` (${failedGates.length} failed)` : ''}
                </h3>
                <SubmissionGateList gates={view.gates} />
              </section>
            )}

            {view.status === 'approved' && view.listing && (
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <TrustTierBadge tier="unverified" />
                <Link href={pluginPagePath(view.listing.publisher, view.listing.name)} className="action-link" data-testid="listing-link">
                  View the listing
                </Link>
              </p>
            )}

            {(view.status === 'gate_failed' || view.status === 'rejected' || view.status === 'expired') && (
              <Link href="/plugins/submit" className="action-link text-sm">Submit a new version</Link>
            )}
          </div>
        )}
      </div>
    </PublicLayout>
  );
}
