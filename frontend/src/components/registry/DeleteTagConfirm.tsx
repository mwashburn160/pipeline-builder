// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { CopyButton } from '@/components/ui/CopyButton';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { api } from '@/lib/api';
import { scanTagsForDigest } from '@/lib/registry-scan';

interface DeleteTagConfirmProps {
  repo: string;
  tagRef: string;
  onClose: () => void;
  onDeleted: (digest?: string) => void;
}

/**
 * Destructive confirm for tag deletion. On open, resolves the tag → digest then
 * scans the repo's other tags for the ones that share it — those tags all stop
 * working, because distribution deletes manifests by digest. Renders
 * incremental progress so a slow registry doesn't show a blank modal for
 * seconds at a time.
 */
export function DeleteTagConfirm({ repo, tagRef, onClose, onDeleted }: DeleteTagConfirmProps) {
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
    void (async () => {
      try {
        const manifest = await api.getImageManifest(repo, tagRef);
        if (aborted) return;
        const d = manifest.data?.digest ?? '';
        setDigest(d);

        const found = await scanTagsForDigest(repo, d, {
          isCancelled: () => aborted,
          onScope: (toScan, skipped) => { setTotalToScan(toScan); setExtraTagCount(skipped); },
          onProgress: setScanned,
        });
        if (found) {
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
  }, [repo, tagRef]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.deleteImageManifest(repo, tagRef);
      onDeleted(res.data?.digest ?? digest ?? undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Delete tag" onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        <div className="text-sm text-fg-muted">
          You are about to delete the manifest pointed to by:
        </div>
        <div className="font-mono text-sm text-fg break-all">
          {repo}:{tagRef}
        </div>

        {scanning && (
          <div className="text-sm text-fg-muted">
            Scanning tags that share the digest… {scanned}/{totalToScan}
          </div>
        )}

        {digest && (
          <div className="text-xs text-fg-muted font-mono break-all flex items-center gap-2">
            <span className="flex-1">digest: {digest}</span>
            <CopyButton text={digest} />
          </div>
        )}

        {!scanning && (() => {
          // `sharedTags` includes the active tag — strip it so the count + list
          // reflects *other* tags that will stop working.
          const others = sharedTags.filter((t) => t !== tagRef);
          if (others.length === 0) return null;
          return (
            <div className="p-3 text-sm border border-warning-border bg-warning-bg text-warning-strong rounded">
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

        {!scanning && sharedTags.filter((t) => t !== tagRef).length === 0 && extraTagCount > 0 && (
          <div className="text-xs italic text-fg-muted">
            {extraTagCount} additional tag(s) were not scanned — they may also share this digest.
          </div>
        )}

        <div className="text-xs text-fg-muted">
          Note: distribution deletes the manifest by digest, so any other tags pointing at the same digest also stop resolving immediately. Blob layers stay on disk as orphans until the registry&apos;s garbage collector runs (a separate maintenance pass — deletion does not reclaim disk on its own). This action is audit-logged.
        </div>

        <ErrorAlert message={error} />

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={submit} disabled={submitting || scanning}>
            {submitting ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
