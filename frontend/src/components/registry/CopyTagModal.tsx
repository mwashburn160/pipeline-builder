// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { api, ApiError, ConflictError } from '@/lib/api';
import { invalidateImageTags } from '@/hooks/useImageTags';

interface CopyTagModalProps {
  sourceRepo: string;
  sourceRef: string;
  /** All loaded repo names — drives target-repo autocomplete suggestions. */
  knownRepos: string[];
  onClose: () => void;
  onSuccess: (targetRepo: string, targetRef: string) => void;
}

/**
 * Modal for copying a tag to another (or the same) repo.
 *
 * Submit flow:
 *  1. Send `overwrite: false`.
 *  2. On `409 target-exists`: surface the conflict and require a second
 *     click on "Overwrite" to resubmit with `overwrite: true`.
 *  3. On `409 source-incomplete`: show the missing digest + retry.
 *  4. On `400 source-equals-target`: inline validation message.
 *
 * Promotion warning fires when the target repo starts with `system/` —
 * those tags are visible to every authenticated user and are audit-logged.
 */
export function CopyTagModal({
  sourceRepo, sourceRef, knownRepos, onClose, onSuccess,
}: CopyTagModalProps) {
  const [targetRepo, setTargetRepo] = useState(sourceRepo);
  const [targetRef, setTargetRef] = useState(sourceRef);
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<{ existing: string; requested: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effectiveTargetRef = targetRef.trim() || sourceRef;
  const target = `${targetRepo.trim()}:${effectiveTargetRef}`;
  const source = `${sourceRepo}:${sourceRef}`;
  const isPromotion = targetRepo.trim().startsWith('system/');

  // Autocomplete suggestions: dedup namespaces from loaded repos to help
  // operators type a common target prefix like `system/foo`.
  const suggestions = Array.from(new Set(knownRepos))
    .filter((r) => r.toLowerCase().startsWith(targetRepo.trim().toLowerCase()) && r !== targetRepo.trim())
    .slice(0, 6);

  const submit = async (overwrite: boolean) => {
    setSubmitting(true);
    setError(null);
    setConflict(null);
    try {
      await api.copyImage({ source, target, overwrite });
      invalidateImageTags(targetRepo.trim());
      onSuccess(targetRepo.trim(), effectiveTargetRef);
    } catch (err) {
      if (err instanceof ConflictError) {
        if (err.reason === 'target-exists' && err.existing && err.requested) {
          setConflict({ existing: err.existing.digest, requested: err.requested.digest });
        } else if (err.reason === 'source-incomplete') {
          setError(`Source manifest references a missing blob: ${err.missingDigest}. Retry — the source may be back if the deletion was transient.`);
        } else if (err.reason === 'source-equals-target') {
          setError('Source and target are identical — pick a different target repo or ref.');
        } else {
          setError(err.message);
        }
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Copy Tag" onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-4">
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Source</div>
          <div className="font-mono text-sm text-gray-900 dark:text-gray-100 break-all">{source}</div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Target repo</label>
          <input
            type="text"
            value={targetRepo}
            onChange={(e) => setTargetRepo(e.target.value)}
            list="copy-target-suggestions"
            placeholder="e.g. system/foo"
            className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          />
          <datalist id="copy-target-suggestions">
            {suggestions.map((s) => <option key={s} value={s} />)}
          </datalist>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Target ref</label>
          <input
            type="text"
            value={targetRef}
            onChange={(e) => setTargetRef(e.target.value)}
            placeholder={sourceRef}
            className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          />
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Leave blank to keep <code>{sourceRef}</code>.</div>
        </div>

        {isPromotion && (
          <div className="p-3 text-sm border border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-900 dark:text-yellow-200 rounded">
            Promoting to <code>system/*</code> makes this image visible to every authenticated user. This action is audit-logged.
          </div>
        )}

        {conflict && (
          <div className="p-3 text-sm border border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-900/20 text-orange-900 dark:text-orange-200 rounded">
            <div className="font-medium mb-2">Target tag already exists with a different digest.</div>
            <div className="text-xs font-mono break-all">existing: {conflict.existing}</div>
            <div className="text-xs font-mono break-all">requested: {conflict.requested}</div>
            <button
              onClick={() => submit(true)}
              disabled={submitting}
              className="mt-2 px-3 py-1.5 text-sm bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
            >
              Overwrite (replace existing tag)
            </button>
          </div>
        )}

        {error && !conflict && (
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
          {!conflict && (
            <button
              onClick={() => submit(false)}
              disabled={submitting || !targetRepo.trim()}
              className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Copying…' : 'Copy'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
