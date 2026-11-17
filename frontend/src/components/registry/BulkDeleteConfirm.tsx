// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useMutation } from '@/hooks/useMutation';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { mapInWaves, PARALLEL_MANIFEST_DELETES, PARALLEL_MANIFEST_READS } from '@/lib/registry-scan';

interface BulkDeleteConfirmProps {
  repo: string;
  refs: string[];
  onClose: () => void;
  /**
   * Fires per-deletion as each tag completes so the parent can update the
   * recent-actions panel + toast incrementally. The final boolean indicates
   * whether ALL tags succeeded.
   */
  onProgress: (ref: string, digest?: string, error?: Error) => void;
  /** Fires once after the entire batch finishes (success or with partial failures). */
  onDone: (summary: { succeeded: number; failed: number }) => void;
}

/** Above this many tags, require a type-to-confirm gate before delete. */
const TYPE_CONFIRM_THRESHOLD = 5;

/**
 * Confirm + executes a bulk delete of N tags from the same repo.
 *
 * Two safety gates layered by destructiveness:
 *  - <=5 tags: plain destructive confirm + count.
 *  - >5 tags: operator must type the count (e.g. "12") to enable submit.
 *
 * Before showing the confirm we run a quick parallel scan of each tag's
 * digest to compute the *distinct-digest count* — multiple tags often
 * point at the same digest, and that's the figure that meaningfully
 * describes what's about to be removed from the registry.
 *
 * On submit, tags are grouped by that digest and ONE delete is issued per
 * digest: Distribution deletes the manifest, so a second delete through a
 * sibling tag would 404 and be miscounted as a failure. Every tag in the group
 * settles with the group's outcome. A 404 for a digest this batch already
 * removed (a tag whose digest the scan could not read, deleted concurrently
 * with its sibling) is likewise counted as success. Groups are dispatched in
 * bounded parallel waves; each tag fires onProgress so the parent can update
 * state incrementally.
 */
export function BulkDeleteConfirm({ repo, refs, onClose, onProgress, onDone }: BulkDeleteConfirmProps) {
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState({ done: 0, succeeded: 0, failed: 0 });
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [distinctDigests, setDistinctDigests] = useState<number | null>(null);
  const [digestScanDone, setDigestScanDone] = useState(0);
  // ref → digest, from the pre-flight scan. Read at submit time to dedupe.
  const digestByRef = useRef<Map<string, string>>(new Map());

  const expectedPhrase = String(refs.length);
  const needsTypeConfirm = refs.length > TYPE_CONFIRM_THRESHOLD;
  const typeConfirmPassed = !needsTypeConfirm || confirmPhrase.trim() === expectedPhrase;

  // Pre-flight: count distinct digests across the selected tags. Bounded
  // concurrency so a large bulk delete doesn't hammer the registry.
  useEffect(() => {
    let cancelled = false;
    setDistinctDigests(null);
    setDigestScanDone(0);
    const seen = new Set<string>();
    const byRef = new Map<string, string>();
    digestByRef.current = byRef;
    let done = 0;

    const scanOne = async (ref: string) => {
      try {
        const m = await api.getImageManifest(repo, ref);
        if (m.data?.digest) {
          seen.add(m.data.digest);
          byRef.set(ref, m.data.digest);
        }
      } catch {
        // Skip — counted below regardless.
      }
      done++;
      if (!cancelled) setDigestScanDone(done);
    };

    void (async () => {
      const completed = await mapInWaves(refs, PARALLEL_MANIFEST_READS, scanOne, () => cancelled);
      if (completed) setDistinctDigests(seen.size);
    })();

    return () => { cancelled = true; };
  }, [repo, refs]);

  const runBatch = async () => {
    let succeeded = 0;
    let failed = 0;
    let done = 0;

    const digestOf = digestByRef.current;
    const deletedDigests = new Set<string>();

    const settle = (ref: string, digest?: string, error?: Error) => {
      if (error) failed++;
      else succeeded++;
      onProgress(ref, digest, error);
      done++;
      setProgress({ done, succeeded, failed });
    };

    // One group per known digest; a tag the scan couldn't resolve is its own group.
    const groups = new Map<string, string[]>();
    for (const ref of refs) {
      const digest = digestOf.get(ref);
      const key = digest ? `digest:${digest}` : `ref:${ref}`;
      const group = groups.get(key);
      if (group) group.push(ref);
      else groups.set(key, [ref]);
    }

    const deleteGroup = async (groupRefs: string[]) => {
      const known = digestOf.get(groupRefs[0]);
      if (known && deletedDigests.has(known)) {
        groupRefs.forEach((r) => settle(r, known));
        return;
      }
      try {
        const res = await api.deleteImageManifest(repo, groupRefs[0]);
        const digest = res.data?.digest ?? known;
        if (digest) deletedDigests.add(digest);
        groupRefs.forEach((r) => settle(r, digest));
      } catch (err) {
        if (known && deletedDigests.has(known) && err instanceof ApiError && err.statusCode === 404) {
          groupRefs.forEach((r) => settle(r, known));
        } else {
          groupRefs.forEach((r) => settle(r, undefined, err as Error));
        }
      }
    };

    await mapInWaves([...groups.values()], PARALLEL_MANIFEST_DELETES, deleteGroup);

    // Keep the delete button disabled after the batch completes — re-clicking
    // would re-issue deletes against already-removed refs.
    setComplete(true);
    onDone({ succeeded, failed });
  };
  // The lock matters here: a second click mid-batch would re-issue every delete.
  const batch = useMutation({ fn: runBatch, scopeKey: repo });
  const submitting = batch.pending;
  const submit = () => { void batch.run(); };

  const digestScanProgress = distinctDigests === null
    ? `Scanning digests… ${digestScanDone}/${refs.length}`
    : null;

  return (
    <Modal title={`Delete ${refs.length} tag${refs.length === 1 ? '' : 's'}`} onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        <div className="text-sm text-fg-muted">
          You are about to delete <strong>{refs.length}</strong> tag{refs.length === 1 ? '' : 's'} from <span className="font-mono">{repo}</span>.
        </div>

        <div className="p-3 text-sm border border-warning-border bg-warning-bg text-warning-strong rounded max-h-48 overflow-auto">
          <div className="font-medium mb-1">Tags:</div>
          <ul className="font-mono text-xs space-y-0.5">
            {refs.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>

        {/* Distinct-digest summary — the count that describes what's
            actually being removed from the registry, since multiple tags
            often point at the same manifest. */}
        <div className="text-xs text-fg-muted">
          {digestScanProgress ?? (
            distinctDigests === refs.length
              ? `All ${refs.length} tags point at distinct digests — ${refs.length} manifest${refs.length === 1 ? '' : 's'} will be deleted.`
              : `${refs.length} tags resolve to ${distinctDigests} distinct digest${distinctDigests === 1 ? '' : 's'} — that's the number of manifests that will actually be removed.`
          )}
        </div>

        <div className="text-xs text-fg-muted">
          Distribution deletes manifests by digest — other tags pointing to the same digest will also stop working. Blob layers stay on disk as orphans until the registry&apos;s garbage collector runs (a separate maintenance pass). Each deletion is audit-logged.
        </div>

        {needsTypeConfirm && !submitting && (
          <div className="p-3 text-sm border border-danger-border bg-danger-bg text-danger-strong rounded">
            <label htmlFor="bulk-delete-confirm" className="block text-xs font-medium mb-1">
              Type <code className="font-mono font-bold">{expectedPhrase}</code> (the count) to confirm:
            </label>
            <Input
              id="bulk-delete-confirm"
              type="text"
              value={confirmPhrase}
              onChange={(e) => setConfirmPhrase(e.target.value)}
              placeholder={expectedPhrase}
              aria-label={`Type ${expectedPhrase} to confirm bulk delete`}
              className="w-full px-3 py-1.5 text-sm font-mono border border-danger-border rounded-md bg-surface text-fg"
              autoFocus
            />
          </div>
        )}

        {submitting && (
          <div className="text-sm text-fg-muted">
            Deleting… {progress.done}/{refs.length}
            {progress.failed > 0 && <span className="text-danger"> ({progress.failed} failed)</span>}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={submit}
            disabled={submitting || complete || !typeConfirmPassed}
            title={!typeConfirmPassed ? `Type ${expectedPhrase} above to enable` : undefined}
          >
            {complete ? 'Done' : submitting ? `Deleting (${progress.done}/${refs.length})…` : `Delete ${refs.length}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
