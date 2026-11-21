// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import { formatBytes } from '@/lib/format';
import type { PluginDeleteJobAccepted, PluginDeleteJobStatus } from '@pipeline-builder/api-core/plugin-scan';
import type { PluginBatchActionResult, PluginDeletePreview } from '@/types/plugin-remediation';
import { PluginDeleteSkipList } from './PluginInUseModal';

/**
 * The refusals a by-name delete / restore / purge can answer with, worded for a
 * person. Anything else falls through to the server's own message.
 */
export function pluginByNameError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.statusCode === 429) {
      const wait = err.retryAfter ? ` Try again in about ${Math.ceil(err.retryAfter / 60)} minute${err.retryAfter > 60 ? 's' : ''}.` : ' Try again later.';
      return `Your organization has reached the limit of 10 whole-plugin deletes, restores and purges per hour.${wait}`;
    }
    if (err.code === 'PLUGIN_MANAGED_NAME_RESERVED') {
      return 'This is a platform-managed toolchain plugin. Its versions are maintained by the platform and cannot be deleted.';
    }
    if (err.code === 'PLUGIN_NAME_LOCKED') {
      return 'Another delete, restore or purge of this plugin is still running. Wait for it to finish and try again.';
    }
  }
  return formatError(err, fallback);
}

/** How often the dialog asks for the delete job's status. */
export const DELETE_JOB_POLL_MS = 2_000;
/** Consecutive failed status reads before the dialog stops and says so. */
const DELETE_JOB_POLL_MAX_FAILURES = 5;

function sumBytes(rows: ReadonlyArray<{ sourceBytes: number | null }>): number {
  return rows.reduce((n, r) => n + (r.sourceBytes ?? 0), 0);
}

/**
 * "Delete plugin (all versions)". Loads the server's delete PREVIEW first — the
 * same answer scripts get — and shows how many versions will be deleted, which
 * are skipped and why, and what in-flight builds and remediations the delete
 * cancels. Confirms with step-up. The server answers 202 with a job id; the
 * dialog polls the job until it finishes and then shows what was deleted and
 * skipped. Listed names get the ecosystem request offer
 * (the delete never changes the listing); a name inherited from the root org
 * has nothing here to delete.
 */
export function DeletePluginDialog({ name, onClose, onDeleted }: {
  name: string;
  onClose: () => void;
  /** After a delete that removed at least one version (refresh the list). */
  onDeleted?: (result: PluginDeleteJobStatus) => void;
}) {
  const { data: preview, loading, error: loadError, refetch } = useFetch<PluginDeletePreview>(async () => {
    const res = await api.getPluginDeletePreview(name);
    if (!res.data) throw new Error('Could not load the delete preview');
    return res.data;
  }, [name]);
  const [force, setForce] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<PluginDeleteJobAccepted | null>(null);
  const [result, setResult] = useState<PluginDeleteJobStatus | null>(null);

  const listedSkips = preview?.skipped.filter((s) => s.reason === 'listed') ?? [];
  const deleteCount = (preview?.deletable.length ?? 0) + (force ? listedSkips.length : 0);
  const shownSkips = preview ? preview.skipped.filter((s) => !(force && s.reason === 'listed')) : [];

  // The latest callback, without restarting the poll when the parent re-renders.
  const onDeletedRef = useRef(onDeleted);
  onDeletedRef.current = onDeleted;

  // Poll the accepted job until it settles.
  useEffect(() => {
    if (!job) return undefined;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const res = await api.getPluginDeleteJob(name, job.jobId, { signal: controller.signal });
        if (stopped) return;
        const status = res.data;
        // An answer without a status is a failed read too: counted toward the
        // same stop, so a broken reply can never keep the dialog polling forever.
        if (!status) throw new Error('Could not read the delete\'s progress; check Recently deleted');
        failures = 0;
        if (status.state !== 'running') {
          setJob(null);
          if (status.state === 'failed') {
            setError(`The delete did not finish: ${status.error?.message ?? 'unknown error'}`);
            return;
          }
          setResult(status);
          if (status.deleted.length > 0) onDeletedRef.current?.(status);
          return;
        }
      } catch (err) {
        if (stopped) return;
        failures += 1;
        if ((err instanceof ApiError && err.statusCode === 404) || failures >= DELETE_JOB_POLL_MAX_FAILURES) {
          setJob(null);
          setError(pluginByNameError(err, 'Could not read the delete\'s progress; check Recently deleted'));
          return;
        }
      }
      timer = setTimeout(() => void poll(), DELETE_JOB_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [job, name]);

  const execute = async (stepUpToken: string) => {
    setError(null);
    try {
      const res = await api.deletePluginByName(name, { force, stepUpToken });
      if (res.data) setJob(res.data);
    } catch (err) {
      setError(pluginByNameError(err, 'Failed to delete the plugin'));
    } finally {
      setConfirming(false);
    }
  };

  const footer = result ? (
    <div className="flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
  ) : (
    <div className="flex justify-end gap-2">
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      {preview && !preview.inheritedFromRoot && (
        <Button variant="danger" disabled={deleteCount === 0 || job !== null} onClick={() => setConfirming(true)}>
          Delete {deleteCount} version{deleteCount === 1 ? '' : 's'}
        </Button>
      )}
    </div>
  );

  return (
    <>
      <Modal title={`Delete plugin ${name}`} onClose={onClose} maxWidth="max-w-lg" footer={footer}>
        <div className="space-y-4 text-sm" data-testid="delete-plugin-dialog">
          {error && <Callout variant="danger">{error}</Callout>}
          {result ? (
            <div className="space-y-3" data-testid="delete-plugin-result">
              <p className="text-fg">
                Deleted {result.deleted.length} version{result.deleted.length === 1 ? '' : 's'}
                {result.deleted.length > 0 ? `: ${result.deleted.map((d) => d.version).join(', ')}` : ''}.
                {result.deleted.length > 0 && ' They can be restored together from Recently deleted until the retention window ends.'}
              </p>
              {result.skipped.length > 0 && (
                <>
                  <p className="text-fg">Skipped {result.skipped.length}:</p>
                  <PluginDeleteSkipList name={name} skipped={result.skipped} />
                </>
              )}
            </div>
          ) : job ? (
            <p role="status" className="text-fg" data-testid="delete-plugin-running">
              Deleting {name}… In-flight builds and remediations are cancelled first and running builds are allowed to finish,
              which can take a few minutes. You can close this dialog; the delete carries on and its versions appear in Recently deleted.
            </p>
          ) : loading && !preview ? (
            <p role="status" className="text-fg-subtle">Checking what would be deleted…</p>
          ) : loadError && !preview ? (
            <div className="space-y-2">
              <Callout variant="danger">{pluginByNameError(loadError, 'Could not load the delete preview')}</Callout>
              <Button variant="secondary" size="sm" onClick={() => void refetch()}>Retry</Button>
            </div>
          ) : preview?.inheritedFromRoot ? (
            <Callout variant="info" title="This plugin comes from your root organization">
              Your team uses <span className="font-mono">{name}</span> from the root organization, so there is nothing here to delete.
              Ask an administrator of the root organization to delete it there.
            </Callout>
          ) : preview ? (
            <>
              <p className="text-fg" data-testid="delete-plugin-summary">
                {preview.deletable.length} version{preview.deletable.length === 1 ? '' : 's'} will be deleted
                {preview.deletable.length > 0 ? ` (${preview.deletable.map((d) => d.version).join(', ')})` : ''}
                {sumBytes(preview.deletable) > 0 ? `, with ${formatBytes(sumBytes(preview.deletable))} of kept source` : ''}.
                {' '}Deleted versions can be restored for the retention window, then are purged with their sources and images.
              </p>
              {preview.skipped.length > 0 && (
                <div className="space-y-2">
                  <p className="text-fg">{shownSkips.length} version{shownSkips.length === 1 ? '' : 's'} will be skipped:</p>
                  <PluginDeleteSkipList name={name} skipped={shownSkips} />
                </div>
              )}
              {(preview.inFlight.builds > 0 || preview.inFlight.remediations > 0) && (
                <Callout variant="warning">
                  {preview.inFlight.builds > 0 && `${preview.inFlight.builds} build${preview.inFlight.builds === 1 ? '' : 's'}`}
                  {preview.inFlight.builds > 0 && preview.inFlight.remediations > 0 && ' and '}
                  {preview.inFlight.remediations > 0 && `${preview.inFlight.remediations} security remediation${preview.inFlight.remediations === 1 ? '' : 's'}`}
                  {' '}of this plugin will be cancelled first, and nothing new can be built under the name while the delete runs.
                </Callout>
              )}
              {listedSkips.length > 0 && (
                <label className="flex items-start gap-2 text-fg">
                  <Checkbox checked={force} onChange={(e) => setForce(e.target.checked)} />
                  <span>Also delete the listed source versions (installers keep running the listed copies)</span>
                </label>
              )}
              {preview.listing && (
                <Callout variant="info" title="This plugin is listed in the ecosystem">
                  Deleting it here never changes the listing: installers keep running the listed copies. To stop new installs,{' '}
                  <Link
                    href={`/dashboard/publisher?tab=listings&listingId=${encodeURIComponent(preview.listing.id)}`}
                    className="action-link"
                  >
                    request &quot;unmaintained&quot; or a yank on the Publisher page
                  </Link>.
                </Callout>
              )}
            </>
          ) : null}
        </div>
      </Modal>
      {confirming && (
        <StepUpModal
          title={`Delete ${deleteCount} version${deleteCount === 1 ? '' : 's'} of ${name}?`}
          action={`Re-confirm your password to delete every eligible version of the plugin "${name}".`}
          details={<p>Pipelines keep the versions they use; those are skipped. You can restore this delete as one batch from Recently deleted.</p>}
          onConfirmed={execute}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** "Restore plugin" / "Purge plugin" result, as a toast-sized sentence. */
export function describeBatchResult(verb: 'Restored' | 'Purged', name: string, r: PluginBatchActionResult): string {
  const done = `${verb} ${r.done.length} version${r.done.length === 1 ? '' : 's'} of ${name}`;
  if (r.skipped.length === 0) return `${done}.`;
  return `${done}; skipped ${r.skipped.map((s) => `${s.version} (${s.reason.replace(/_/g, ' ')})`).join(', ')}.`;
}
