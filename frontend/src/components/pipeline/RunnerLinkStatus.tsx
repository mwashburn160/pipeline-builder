// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import type { RunnerLinkDto } from '@pipeline-builder/api-core/pipeline-runners';
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
  usePolling(() => refetch(), RUNNER_LINK_CHECK_POLL_MS, { immediate: false, enabled: link?.status === 'checking' });

  const refresh = useCallback(async (stepUpToken: string) => {
    const r = await api.refreshPipelineRunnerLink(pipelineId, stepUpToken);
    if (!r.success) throw new Error(r.message || 'Could not look for the runner again');
    if (r.data) setOverride(r.data);
  }, [pipelineId]);

  return { link, error: read.error, refetch, refresh };
}

/** "A and B" / "A, B and C". */
function andList(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * The Deployment card's "Runs via" row: the link status (Linked / Not linked
 * yet / Not found / Two runners matched / Checking) and Find runner again.
 * The runner is always found by the pipeline's pb.pipeline-id tag — never
 * picked by hand — so this shows and refreshes the link, nothing more.
 */
export function RunnerLinkRow({ link, canRefresh, onFindAgain }: {
  link: RunnerLinkDto;
  canRefresh: boolean;
  onFindAgain: () => void;
}) {
  const checked = link.detail?.runnersChecked?.filter(Boolean) ?? [];
  const matched = link.detail?.matched?.filter(Boolean) ?? [];
  const kept = link.runner && link.status !== 'linked' && link.status !== 'checking' ? link.runner : null;
  return (
    <div className="flex justify-between gap-2" data-testid="runner-link">
      <dt className="text-fg-muted">Runs via</dt>
      <dd className="text-right space-y-0.5" data-testid="runner-link-status" data-status={link.status}>
        {link.status === 'linked' && link.runner && (
          <>
            <div data-testid="deployment-runner">
              <strong>{link.runner.label}</strong>{link.runner.ownerOrgName ? <span className="text-fg-subtle"> (shared by {link.runner.ownerOrgName})</span> : null}
            </div>
            <div className="text-xs text-fg-muted">Linked{link.checkedAt && <> · checked <RelativeTime value={link.checkedAt} /></>}</div>
          </>
        )}
        {(link.status === 'unlinked' || (link.status === 'linked' && !link.runner)) && (
          <>
            <div>Not linked yet</div>
            <div className="text-xs text-fg-muted">The first run finds its runner by the pipeline&apos;s pb.pipeline-id tag.</div>
          </>
        )}
        {link.status === 'not_found' && (
          <>
            <div className="text-danger">Not found</div>
            <div className="text-xs text-fg-muted">
              {checked.length > 0
                ? <>Runners checked: {checked.join(', ')}.</>
                : <>No runner to check. <Link href={PIPELINE_RUNNERS_HREF} className="underline">Install a runner</Link>.</>}
            </div>
          </>
        )}
        {link.status === 'ambiguous' && (
          <>
            <div className="text-danger">Two runners matched{matched.length > 0 ? `: ${andList(matched)}` : ''}</div>
            <div className="text-xs text-fg-muted">{runnerErrorCopy('AMBIGUOUS_RUNNER').body}</div>
          </>
        )}
        {link.status === 'checking' && (
          <div className="inline-flex items-center gap-1.5"><LoadingSpinner size="sm" label={null} /> Checking…</div>
        )}
        {kept && <div className="text-xs text-fg-muted" data-testid="runner-link-kept">Still linked to {kept.label}.</div>}
        {canRefresh && (
          <Button type="button" size="xs" variant="ghost" className="inline-flex items-center gap-1" disabled={link.status === 'checking'}
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
 * the admins who own it).
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
              {canTest && !runner.ownerOrgName
                ? <Button type="button" size="xs" variant="secondary" onClick={onTest}>Test</Button>
                : <Link href={PIPELINE_RUNNERS_HREF} className="underline">Settings → Pipeline runners</Link>}
            </span>
          )}
        />
      )}
    </>
  );
}
