// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { CopyButton } from '@/components/ui/CopyButton';
import { api } from '@/lib/api';

interface DeleteTagConfirmProps {
  repo: string;
  ref: string;
  onClose: () => void;
  onDeleted: (digest?: string) => void;
}

const MAX_TAGS_TO_SCAN = 50;
const PARALLEL_FETCH = 8;

/**
 * Destructive confirm for tag deletion. On open, resolves the tag → digest
 * then scans up to 50 other tags in the same repo (8 in parallel) to find
 * which ones share the digest — those tags all stop working because
 * distribution deletes manifests by digest. Renders incremental progress so
 * a slow registry doesn't show a blank modal for seconds at a time.
 */
export function DeleteTagConfirm({ repo, ref, onClose, onDeleted }: DeleteTagConfirmProps) {
  const [digest, setDigest] = useState<string | null>(null);
  const [sharedTags, setSharedTags] = useState<string[]>([]);
  const [scanned, setScanned] = useState(0);
  const [totalToScan, setTotalToScan] = useState(0);
  const [extraTagCount, setExtraTagCount] = useState(0);
  const [scanning, setScanning] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        const manifest = await api.getImageManifest(repo, ref);
        if (aborted) return;
        const d = manifest.data?.digest ?? '';
        setDigest(d);

        const tagsRes = await api.listImageTags(repo);
        if (aborted) return;
        const allTags = tagsRes.data?.tags ?? [];
        const toScan = allTags.slice(0, MAX_TAGS_TO_SCAN);
        setTotalToScan(toScan.length);
        setExtraTagCount(Math.max(0, allTags.length - MAX_TAGS_TO_SCAN));

        // Parallelized scan with incremental updates.
        const found: string[] = [];
        let done = 0;
        const scanOne = async (t: string) => {
          try {
            const m = await api.getImageManifest(repo, t);
            if (m.data?.digest === d) found.push(t);
          } catch {
            // skip — counted below regardless
          }
          done++;
          if (!aborted) setScanned(done);
        };
        for (let i = 0; i < toScan.length; i += PARALLEL_FETCH) {
          if (aborted) return;
          await Promise.all(toScan.slice(i, i + PARALLEL_FETCH).map(scanOne));
        }
        if (!aborted) {
          setSharedTags(found.sort());
          setScanning(false);
        }
      } catch (err) {
        if (!aborted) {
          setError((err as Error).message);
          setScanning(false);
        }
      }
    })();
    return () => { aborted = true; };
  }, [repo, ref]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.deleteImageManifest(repo, ref);
      onDeleted(res.data?.digest ?? digest ?? undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Delete Tag" onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        <div className="text-sm text-gray-700 dark:text-gray-300">
          You are about to delete the manifest pointed to by:
        </div>
        <div className="font-mono text-sm text-gray-900 dark:text-gray-100 break-all">
          {repo}:{ref}
        </div>

        {scanning && (
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Scanning tags that share the digest… {scanned}/{totalToScan}
          </div>
        )}

        {digest && (
          <div className="text-xs text-gray-500 dark:text-gray-400 font-mono break-all flex items-center gap-2">
            <span className="flex-1">digest: {digest}</span>
            <CopyButton text={digest} />
          </div>
        )}

        {!scanning && (() => {
          // `sharedTags` includes the active tag — strip it so the count + list
          // reflects *other* tags that will stop working.
          const others = sharedTags.filter((t) => t !== ref);
          if (others.length === 0) return null;
          return (
            <div className="p-3 text-sm border border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-900/20 text-orange-900 dark:text-orange-200 rounded">
              <div className="font-medium mb-1">
                The following {others.length} other tag{others.length === 1 ? '' : 's'} share this digest and will stop working:
              </div>
              <ul className="font-mono text-xs space-y-0.5">
                {others.map((t) => <li key={t}>{t}</li>)}
              </ul>
              {extraTagCount > 0 && (
                <div className="text-xs mt-2 italic">…and {extraTagCount} more tag(s) not scanned.</div>
              )}
            </div>
          );
        })()}

        {!scanning && sharedTags.filter((t) => t !== ref).length === 0 && extraTagCount > 0 && (
          <div className="text-xs italic text-gray-500 dark:text-gray-400">
            {extraTagCount} additional tag(s) were not scanned — they may also share this digest.
          </div>
        )}

        <div className="text-xs text-gray-500 dark:text-gray-400">
          Note: distribution deletes the manifest by digest, so any other tags pointing at the same digest also stop resolving immediately. Blob layers stay on disk as orphans until the registry's garbage collector runs (a separate maintenance pass — deletion does not reclaim disk on its own). This action is audit-logged.
        </div>

        {error && (
          <div className="p-3 text-sm border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 rounded">
            {error}
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
            disabled={submitting || scanning}
            className="px-4 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
          >
            {submitting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
