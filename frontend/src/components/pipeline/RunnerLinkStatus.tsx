// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import type { RunnerLinkDto, RunnerLinkStatus } from '@pipeline-builder/api-core/pipeline-runners';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { WarningAlert } from '@/components/ui/WarningAlert';
import { useFetch } from '@/hooks/useFetch';
import { usePolling } from '@/hooks/usePolling';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { PIPELINE_RUNNERS_HREF, runnerErrorCopy } from '@/lib/pipeline-runners';

/** How often the page re-reads the link while a Find runner again probe runs. */
export const RUNNER_LINK_CHECK_POLL_MS = 3_000;

/** How long the page watches one `checking` before it calls the check stalled:
 *  it stops polling and offers Find runner again. A probe whose replica died
 *  (or that failed without recording an outcome) leaves the row `checking`,
 *  which would otherwise poll forever and keep the button disabled. Measured on
 *  this browser's clock from when the page first saw the check, so server
 *  clock skew cannot misjudge it. */
export const RUNNER_LINK_CHECK_STALE_MS = 180_000;

/**
 * A pipeline's link to its runner: read on mount, replaced by a refresh's 202
 * (`checking`), and re-read every few seconds until the probe settles. A 404
 * (the pipeline is not registered) reads as no link at all. Never fatal: a
 * failed read just hides the row.
 */
export function useRunnerLink(pipelineId: string) {
  const read = useFetch(async (signal): Promise<RunnerLinkDto | null> => {
    if (!pipelineId) return null;
    try {
      const r = await api.getPipelineRunnerLink(pipelineId, { signal });
      return r.success ? r.data ?? null : null;
    } catch (e) {
      if (e instanceof ApiError && e.statusCode === 404) return null;
      throw e;
    }
  }, [pipelineId]);
  // A refresh's own answer shows at once, until the next read replaces it.
  const [override, setOverride] = useState<RunnerLinkDto | null>(null);
  useEffect(() => { setOverride(null); }, [read.data]);
  const link = override ?? read.data;
  const { refetch } = read;
  const checking = link?.status === 'checking';
  // When this page first saw the current check (reset by every refresh).
  const [checkingSince, setCheckingSince] = useState<number | null>(null);
  useEffect(() => {
    if (!checking) setCheckingSince(null);
    else setCheckingSince((since) => since ?? Date.now());
  }, [checking]);
  // Re-evaluated on every render; the polls below re-render until it flips.
  const stalled = checking && checkingSince !== null && Date.now() - checkingSince >= RUNNER_LINK_CHECK_STALE_MS;
  usePolling(() => refetch(), RUNNER_LINK_CHECK_POLL_MS, { immediate: false, enabled: checking && !stalled });

  const refresh = useCallback(async (stepUpToken: string) => {
    const r = await api.refreshPipelineRunnerLink(pipelineId, stepUpToken);
    if (!r.success) throw new Error(r.message || 'Could not look for the runner again');
    setCheckingSince(Date.now());
    if (r.data) setOverride(r.data);
  }, [pipelineId]);

  return { link, stalled, error: read.error, refetch, refresh };
}

/** "A and B" / "A, B and C". */
function andList(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** Unlinked, or linked to a runner the DTO no longer names. */
const NOT_LINKED_YET = (
  <>
    <div>Not linked yet</div>
    <div className="text-xs text-fg-muted">The first run finds its runner by the pipeline&apos;s pb.pipeline-id tag.</div>
  </>
);

/** What one link status shows, given the link and whether its check stalled. */
interface LinkStatusView { link: RunnerLinkDto; stalled: boolean }

/**
 * The "Runs via" body per link status, keyed by api-core's RUNNER_LINK_STATUSES:
 * a status added there without a view here is a compile error. (An unknown
 * status from a newer server renders no body, only Find runner again.)
 */
const LINK_STATUS_VIEWS = {
  linked: ({ link }: LinkStatusView) => (link.runner
    ? (
      <>
        <div data-testid="deployment-runner">
          <strong>{link.runner.label}</strong>{link.runner.isOwn ? null : <span className="text-fg-subtle"> (shared by {link.runner.ownerOrgName ?? 'a parent organization'})</span>}
        </div>
        <div className="text-xs text-fg-muted">Linked{link.checkedAt && <> · checked <RelativeTime value={link.checkedAt} /></>}</div>
      </>
    )
    : NOT_LINKED_YET),
  unlinked: () => NOT_LINKED_YET,
  not_found: ({ link }: LinkStatusView) => {
    const checked = link.detail?.runnersChecked?.filter(Boolean) ?? [];
    return (
      <>
        <div className="text-danger">Not found</div>
        <div className="text-xs text-fg-muted">
          {checked.length > 0
            ? <>Runners checked: {checked.join(', ')}.</>
            : <>No runner to check. <Link href={PIPELINE_RUNNERS_HREF} className="underline">Install a runner</Link>.</>}
        </div>
      </>
    );
  },
  ambiguous: ({ link }: LinkStatusView) => {
    const matched = link.detail?.matched?.filter(Boolean) ?? [];
    return (
      <>
        <div className="text-danger">Two runners matched{matched.length > 0 ? `: ${andList(matched)}` : ''}</div>
        <div className="text-xs text-fg-muted">{runnerErrorCopy('AMBIGUOUS_RUNNER').body}</div>
      </>
    );
  },
  checking: ({ stalled }: LinkStatusView) => (stalled
    ? (
      <>
        <div>Check not finished</div>
        <div className="text-xs text-fg-muted" data-testid="runner-link-stalled">The last check did not finish. Try Find runner again.</div>
      </>
    )
    : <div className="inline-flex items-center gap-1.5"><LoadingSpinner size="sm" label={null} /> Checking…</div>),
} satisfies Record<RunnerLinkStatus, (v: LinkStatusView) => ReactNode>;

/**
 * The Deployment card's "Runs via" row: the link status (Linked / Not linked
 * yet / Not found / Two runners matched / Checking) and Find runner again.
 * The runner is always found by the pipeline's pb.pipeline-id tag — never
 * picked by hand — so this shows and refreshes the link, nothing more.
 */
export function RunnerLinkRow({ link, stalled = false, canRefresh, onFindAgain }: {
  link: RunnerLinkDto;
  /** A `checking` the page gave up waiting for (see RUNNER_LINK_CHECK_STALE_MS). */
  stalled?: boolean;
  canRefresh: boolean;
  onFindAgain: () => void;
}) {
  const checking = link.status === 'checking' && !stalled;
  const kept = link.runner && link.status !== 'linked' && !checking ? link.runner : null;
  const view = Object.hasOwn(LINK_STATUS_VIEWS, link.status) ? LINK_STATUS_VIEWS[link.status] : null;
  return (
    <div className="flex justify-between gap-2" data-testid="runner-link">
      <dt className="text-fg-muted">Runs via</dt>
      <dd className="text-right space-y-0.5" data-testid="runner-link-status" data-status={link.status}>
        {view?.({ link, stalled })}
        {kept && <div className="text-xs text-fg-muted" data-testid="runner-link-kept">Still linked to {kept.label}.</div>}
        {canRefresh && (
          <Button type="button" size="xs" variant="ghost" className="inline-flex items-center gap-1" disabled={checking}
            onClick={onFindAgain}>
            <RefreshCw className="w-3.5 h-3.5" /> Find runner again
          </Button>
        )}
      </dd>
    </div>
  );
}

/**
 * Page-level banners from the link: the platform pause toggle, and an
 * unhealthy runner (with its last successful contact and a Test button for
 * the admins who own it: the server's `runner.isOwn`, never inferred from
 * `ownerOrgName`, which is also null when a parent org's name is unknown).
 */
export function RunnerLinkBanners({ link, canTest, onTest }: { link: RunnerLinkDto | null; canTest: boolean; onTest: () => void }) {
  if (!link) return null;
  const runner = link.runner;
  return (
    <>
      {link.deliveriesPaused && (
        <WarningAlert
          className="mb-4"
          message={(
            <span data-testid="runner-paused-banner">
              <strong>Pipeline runs are paused on this platform.</strong> Your platform operator has paused all runner
              traffic, so Run and Stop are refused until it is turned back on.
            </span>
          )}
        />
      )}
      {runner && runner.health === 'unreachable' && (
        <WarningAlert
          className="mb-4"
          message={(
            <span data-testid="runner-unhealthy-banner">
              <strong>The runner {runner.label} is not answering.</strong>{' '}
              Last successful contact: {runner.lastDeliveryAt ? <RelativeTime value={runner.lastDeliveryAt} /> : 'never'}.
              {' '}This pipeline cannot run until it answers again.{' '}
              {canTest && runner.isOwn
                ? <Button type="button" size="xs" variant="secondary" onClick={onTest}>Test</Button>
                : <Link href={PIPELINE_RUNNERS_HREF} className="underline">Settings → Pipeline runners</Link>}
            </span>
          )}
        />
      )}
    </>
  );
}
