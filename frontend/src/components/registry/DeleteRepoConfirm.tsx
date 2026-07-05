// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { api } from '@/lib/api';

interface DeleteRepoConfirmProps {
  repo: string;
  onClose: () => void;
  onDeleted: (result: { deletedManifests: number; deletedTags: number; alreadyEmpty?: boolean }) => void;
}

const MAX_TAGS_TO_PREVIEW = 20;

/**
 * Destructive confirm for deleting an ENTIRE repository — every tag/manifest,
 * so the repo drops out of `_catalog`. On open we list the repo's tags to
 * show the blast radius (an empty shell scans as 0 tags and prunes cleanly).
 *
 * Distinct from {@link DeleteTagConfirm}, which removes a single manifest by
 * digest; this removes them all. Both are audit-logged and leave orphaned
 * blobs for the registry GC to reclaim.
 */
export function DeleteRepoConfirm({ repo, onClose, onDeleted }: DeleteRepoConfirmProps) {
  const [tags, setTags] = useState<string[] | null>(null);
  const [scanning, setScanning] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        const res = await api.listImageTags(repo);
        if (aborted) return;
        setTags(res.data?.tags ?? []);
      } catch (err) {
        // A missing/empty repo isn't fatal here — deletion is idempotent, so
        // treat it as an empty repo and let the operator prune the shell.
        if (!aborted) setTags([]);
        void err;
      } finally {
        if (!aborted) setScanning(false);
      }
    })();
    return () => { aborted = true; };
  }, [repo]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.deleteRepository(repo);
      onDeleted({
        deletedManifests: res.data?.deletedManifests ?? 0,
        deletedTags: res.data?.deletedTags ?? 0,
        alreadyEmpty: res.data?.alreadyEmpty,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const tagCount = tags?.length ?? 0;
  const isEmpty = !scanning && tagCount === 0;
  const previewTags = tags?.slice(0, MAX_TAGS_TO_PREVIEW) ?? [];
  const extraTagCount = Math.max(0, tagCount - MAX_TAGS_TO_PREVIEW);

  return (
    <Modal title="Delete Repository" onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        <div className="text-sm text-gray-700 dark:text-gray-300">
          {isEmpty
            ? 'This repository has no tags — prune the empty shell it left in the catalog:'
            : 'You are about to delete the entire repository and every tag it contains:'}
        </div>
        <div className="font-mono text-sm text-gray-900 dark:text-gray-100 break-all">
          {repo}
        </div>

        {scanning && (
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Scanning tags…
          </div>
        )}

        {!scanning && tagCount > 0 && (
          <div className="p-3 text-sm border border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-900/20 text-orange-900 dark:text-orange-200 rounded">
            <div className="font-medium mb-1">
              All {tagCount} tag{tagCount === 1 ? '' : 's'} in this repository will be deleted and stop resolving immediately:
            </div>
            <ul className="font-mono text-xs space-y-0.5">
              {previewTags.map((t) => <li key={t}>{t}</li>)}
            </ul>
            {extraTagCount > 0 && (
              <div className="text-xs mt-2 italic">…and {extraTagCount} more.</div>
            )}
          </div>
        )}

        <div className="text-xs text-gray-500 dark:text-gray-400">
          Note: every manifest is deleted by digest, so all tags stop resolving at once. Blob layers stay on disk as orphans until the registry&apos;s garbage collector runs. This action is audit-logged.
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
            {submitting ? 'Deleting…' : isEmpty ? 'Prune' : 'Delete repository'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
