// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { Link as LinkIcon } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { CopyButton } from '@/components/ui/CopyButton';
import { useToast } from '@/components/ui/Toast';
import { api, ApiError, ConflictError } from '@/lib/api';
import { invalidateImageTags } from '@/hooks/useImageTags';

interface CopyTagModalProps {
  sourceRepo: string;
  sourceRef: string;
  /** All loaded repo names — drives target-repo autocomplete suggestions. */
  knownRepos: string[];
  onClose: () => void;
  onSuccess: (targetRepo: string, targetRef: string, sourceDigest?: string, blobCount?: number) => void;
}

// Mirror of the backend's Zod schema — validate client-side so we don't
// trip a 400 just to render the same error message.
const REPO_REF_REGEX = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_.-]+$/;

// Type-to-confirm phrase for promotions into `system/*`. Picked to be short
// enough to type but specific enough to break muscle memory on "click
// through everything." Case-insensitive to keep it friendly.
const PROMOTE_CONFIRM_PHRASE = 'PROMOTE';

/**
 * Modal for copying a tag to another (or the same) repo.
 *
 * Default target: when the source is in an `org-...` namespace, suggest
 * the matching `system/...` path (the common promotion workflow);
 * otherwise the target starts empty and submit is disabled until the
 * operator picks something distinct from the source.
 *
 * Submit flow:
 *  1. Send `overwrite: false`.
 *  2. On `409 target-exists`: surface the conflict and require a second
 *     click on "Overwrite" to resubmit with `overwrite: true`.
 *  3. On `409 source-incomplete`: show the missing digest + retry.
 *  4. On `400 source-equals-target`: inline validation (rare — the
 *     button is normally disabled in this state).
 */
export function CopyTagModal({
  sourceRepo, sourceRef, knownRepos, onClose, onSuccess,
}: CopyTagModalProps) {
  // Default target: when the source repo starts with `org-` and has a
  // `<ns>/<name>` shape, suggest promoting into `system/<name>`. Otherwise
  // leave the target empty so the operator can't accidentally submit a no-op.
  const defaultTargetRepo = useMemo(() => {
    if (sourceRepo.startsWith('org-')) {
      const slash = sourceRepo.indexOf('/');
      if (slash !== -1) return `system/${sourceRepo.slice(slash + 1)}`;
    }
    return '';
  }, [sourceRepo]);

  const toast = useToast();
  const [targetRepo, setTargetRepo] = useState(defaultTargetRepo);
  const [targetRef, setTargetRef] = useState(sourceRef);
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<{ existing: string; requested: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effectiveTargetRef = targetRef.trim() || sourceRef;
  const target = `${targetRepo.trim()}:${effectiveTargetRef}`;
  const source = `${sourceRepo}:${sourceRef}`;
  const isPromotion = targetRepo.trim().startsWith('system/');
  const isSameAsSource = target === source;
  const isShapeValid = REPO_REF_REGEX.test(target);
  // Promotions require typing PROMOTE — see PROMOTE_CONFIRM_PHRASE rationale.
  const promotionGatePassed = !isPromotion || confirmPhrase.trim().toUpperCase() === PROMOTE_CONFIRM_PHRASE;
  const canSubmit = !submitting && targetRepo.trim().length > 0 && !isSameAsSource && isShapeValid && promotionGatePassed;

  /**
   * Build a shareable deep-link the operator can paste into Slack / ticket
   * comments to ask someone else to perform the same copy. Encodes the
   * source as `?action=copy&source=<repo:ref>` — the registry page
   * consumes those query params and opens this modal pre-filled.
   */
  const shareLink = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const url = new URL(window.location.href);
    url.searchParams.set('action', 'copy');
    url.searchParams.set('source', source);
    url.searchParams.delete('tag');
    url.searchParams.delete('platform');
    url.searchParams.set('repo', sourceRepo);
    return url.toString();
  }, [source, sourceRepo]);

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      toast.success('Share link copied — paste it anywhere to re-open this copy modal.');
    } catch {
      toast.error('Clipboard unavailable in this browser — select and copy the URL manually.');
    }
  };

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
      const res = await api.copyImage({ source, target, overwrite });
      invalidateImageTags(targetRepo.trim());
      onSuccess(
        targetRepo.trim(),
        effectiveTargetRef,
        res.data?.digest,
        res.data?.mounted?.blobs,
      );
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
            autoFocus
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

        {/* Inline validation hints — render only when relevant. */}
        {targetRepo.trim().length > 0 && !isShapeValid && (
          <div className="text-xs text-orange-600 dark:text-orange-400">
            Target must match <code>{'<repo>:<ref>'}</code> (lowercase repo path; ref is alphanumeric + <code>._-</code>).
          </div>
        )}
        {isSameAsSource && (
          <div className="text-xs text-orange-600 dark:text-orange-400">
            Target is identical to source — change the repo or ref.
          </div>
        )}

        {isPromotion && (
          <div className="p-3 text-sm border border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-900 dark:text-yellow-200 rounded space-y-2">
            <div>
              Promoting to <code>system/*</code> makes this image visible to every authenticated user. This action is audit-logged.
            </div>
            <div>
              <label htmlFor="promote-confirm" className="block text-xs font-medium mb-1">
                Type <code className="font-mono font-bold">{PROMOTE_CONFIRM_PHRASE}</code> to confirm:
              </label>
              <input
                id="promote-confirm"
                type="text"
                value={confirmPhrase}
                onChange={(e) => setConfirmPhrase(e.target.value)}
                placeholder={PROMOTE_CONFIRM_PHRASE}
                aria-label={`Type ${PROMOTE_CONFIRM_PHRASE} to confirm promotion`}
                className="w-full px-3 py-1.5 text-sm font-mono border border-yellow-400 dark:border-yellow-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              />
            </div>
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

        {/* Share-link affordance — copy a URL that re-opens this modal
            pre-filled, so the operator can hand the action off to a
            teammate without having to re-find the source tag. */}
        <div className="pt-2 border-t border-gray-100 dark:border-gray-800 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <LinkIcon className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="flex-1">Need someone else to do this? Copy a share link.</span>
          <CopyButton text={shareLink} />
          <button
            onClick={copyShareLink}
            className="underline hover:no-underline"
          >
            Copy share link
          </button>
        </div>

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
              disabled={!canSubmit}
              title={isPromotion && !promotionGatePassed ? `Type ${PROMOTE_CONFIRM_PHRASE} above to enable` : undefined}
              className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Copying…' : isPromotion ? 'Promote' : 'Copy'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
