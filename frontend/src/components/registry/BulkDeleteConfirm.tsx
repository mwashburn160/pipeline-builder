// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { api } from '@/lib/api';

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

const PARALLEL_DELETE = 4;
/** Concurrency cap for the pre-flight digest scan. */
const PARALLEL_DIGEST_SCAN = 8;
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
 * On submit, deletes are dispatched in parallel waves of 4; each
 * completion fires onProgress so the parent can update state incrementally.
 */
export function BulkDeleteConfirm({ repo, refs, onClose, onProgress, onDone }: BulkDeleteConfirmProps) {
  const [submitting, setSubmitting] = useState(false);
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState({ done: 0, succeeded: 0, failed: 0 });
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [distinctDigests, setDistinctDigests] = useState<number | null>(null);
  const [digestScanDone, setDigestScanDone] = useState(0);

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
    let done = 0;

    const scanOne = async (ref: string) => {
      try {
        const m = await api.getImageManifest(repo, ref);
        if (m.data?.digest) seen.add(m.data.digest);
      } catch {
        // Skip — counted below regardless.
      }
      done++;
      if (!cancelled) setDigestScanDone(done);
    };

    (async () => {
      for (let i = 0; i < refs.length; i += PARALLEL_DIGEST_SCAN) {
        if (cancelled) return;
        await Promise.all(refs.slice(i, i + PARALLEL_DIGEST_SCAN).map(scanOne));
      }
      if (!cancelled) setDistinctDigests(seen.size);
    })();

    return () => { cancelled = true; };
  }, [repo, refs]);

  const submit = async () => {
    setSubmitting(true);
    let succeeded = 0;
    let failed = 0;
    let done = 0;

    const deleteOne = async (ref: string) => {
      try {
        const res = await api.deleteImageManifest(repo, ref);
        succeeded++;
        onProgress(ref, res.data?.digest);
      } catch (err) {
        failed++;
        onProgress(ref, undefined, err as Error);
      }
      done++;
      setProgress({ done, succeeded, failed });
    };

    for (let i = 0; i < refs.length; i += PARALLEL_DELETE) {
      const batch = refs.slice(i, i + PARALLEL_DELETE);
      await Promise.all(batch.map(deleteOne));
    }

    // Keep the delete button disabled after the batch completes — re-clicking
    // would re-issue deletes against already-removed refs.
    setComplete(true);
    setSubmitting(false);
    onDone({ succeeded, failed });
  };

  const digestScanProgress = distinctDigests === null
    ? `Scanning digests… ${digestScanDone}/${refs.length}`
    : null;

  return (
    <Modal title={`Delete ${refs.length} tag${refs.length === 1 ? '' : 's'}`} onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        <div className="text-sm text-gray-700 dark:text-gray-300">
          You are about to delete <strong>{refs.length}</strong> tag{refs.length === 1 ? '' : 's'} from <span className="font-mono">{repo}</span>.
        </div>

        <div className="p-3 text-sm border border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-900/20 text-orange-900 dark:text-orange-200 rounded max-h-48 overflow-auto">
          <div className="font-medium mb-1">Tags:</div>
          <ul className="font-mono text-xs space-y-0.5">
            {refs.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>

        {/* Distinct-digest summary — the count that describes what's
            actually being removed from the registry, since multiple tags
            often point at the same manifest. */}
        <div className="text-xs text-gray-600 dark:text-gray-400">
          {digestScanProgress ?? (
            distinctDigests === refs.length
              ? `All ${refs.length} tags point at distinct digests — ${refs.length} manifest${refs.length === 1 ? '' : 's'} will be deleted.`
              : `${refs.length} tags resolve to ${distinctDigests} distinct digest${distinctDigests === 1 ? '' : 's'} — that's the number of manifests that will actually be removed.`
          )}
        </div>

        <div className="text-xs text-gray-500 dark:text-gray-400">
          Distribution deletes manifests by digest — other tags pointing to the same digest will also stop working. Blob layers stay on disk as orphans until the registry's garbage collector runs (a separate maintenance pass). Each deletion is audit-logged.
        </div>

        {needsTypeConfirm && !submitting && (
          <div className="p-3 text-sm border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-900 dark:text-red-200 rounded">
            <label htmlFor="bulk-delete-confirm" className="block text-xs font-medium mb-1">
              Type <code className="font-mono font-bold">{expectedPhrase}</code> (the count) to confirm:
            </label>
            <input
              id="bulk-delete-confirm"
              type="text"
              value={confirmPhrase}
              onChange={(e) => setConfirmPhrase(e.target.value)}
              placeholder={expectedPhrase}
              aria-label={`Type ${expectedPhrase} to confirm bulk delete`}
              className="w-full px-3 py-1.5 text-sm font-mono border border-red-400 dark:border-red-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              autoFocus
            />
          </div>
        )}

        {submitting && (
          <div className="text-sm text-gray-600 dark:text-gray-400">
            Deleting… {progress.done}/{refs.length}
            {progress.failed > 0 && <span className="text-red-600 dark:text-red-400"> ({progress.failed} failed)</span>}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || complete || !typeConfirmPassed}
            title={!typeConfirmPassed ? `Type ${expectedPhrase} above to enable` : undefined}
            className="px-4 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {complete ? 'Done' : submitting ? `Deleting (${progress.done}/${refs.length})…` : `Delete ${refs.length}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
