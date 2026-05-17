// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { api } from '@/lib/api';

interface DeleteTagConfirmProps {
  repo: string;
  ref: string;
  onClose: () => void;
  onDeleted: () => void;
}

const MAX_TAGS_TO_SCAN = 50;

/**
 * Destructive confirm for tag deletion. On open, resolves the tag → digest
 * then scans up to 50 other tags in the same repo (HEAD each manifest) to
 * find which ones share the digest — those tags will also stop working
 * because distribution deletes manifests by digest.
 *
 * If the repo has more than 50 tags, the modal surfaces "and X more" so
 * the operator knows the impact is broader than what's listed.
 */
export function DeleteTagConfirm({ repo, ref, onClose, onDeleted }: DeleteTagConfirmProps) {
  const [digest, setDigest] = useState<string | null>(null);
  const [sharedTags, setSharedTags] = useState<string[]>([]);
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
        setExtraTagCount(Math.max(0, allTags.length - MAX_TAGS_TO_SCAN));

        // Find tags pointing to the same digest.
        const found: string[] = [];
        for (const t of toScan) {
          if (aborted) return;
          try {
            const m = await api.getImageManifest(repo, t);
            if (m.data?.digest === d) found.push(t);
          } catch {
            // Tag fetch failed — skip; it'll be reported on actual delete if relevant.
          }
        }
        if (!aborted) {
          setSharedTags(found);
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
      await api.deleteImageManifest(repo, ref);
      onDeleted();
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
          <div className="text-sm text-gray-500 dark:text-gray-400">Scanning tags that share the digest…</div>
        )}

        {!scanning && digest && (
          <div className="text-xs text-gray-500 dark:text-gray-400 font-mono break-all">
            digest: {digest}
          </div>
        )}

        {!scanning && sharedTags.length > 1 && (
          <div className="p-3 text-sm border border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-900/20 text-orange-900 dark:text-orange-200 rounded">
            <div className="font-medium mb-1">
              The following {sharedTags.length} tags share this digest and will stop working:
            </div>
            <ul className="font-mono text-xs space-y-0.5">
              {sharedTags.map((t) => <li key={t}>{t}</li>)}
            </ul>
            {extraTagCount > 0 && (
              <div className="text-xs mt-2 italic">…and {extraTagCount} more tag(s) not scanned.</div>
            )}
          </div>
        )}

        {!scanning && sharedTags.length === 1 && extraTagCount > 0 && (
          <div className="text-xs italic text-gray-500 dark:text-gray-400">
            {extraTagCount} additional tag(s) were not scanned — they may also share this digest.
          </div>
        )}

        <div className="text-xs text-gray-500 dark:text-gray-400">
          Note: blob layers become orphaned until the registry's garbage collector runs.
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
