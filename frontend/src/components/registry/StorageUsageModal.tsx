// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Input } from '@/components/ui/Input';
import { api, ApiError } from '@/lib/api';
import type { RegistryStorageUsage } from '@/lib/api/domains/registry';
import { fmtNum, formatBytes, formatDateTime } from '@/lib/format';

interface StorageUsageModalProps {
  /** Whether the modal is shown. Kept mounted so the prefix + last result survive close/reopen. */
  open: boolean;
  onClose: () => void;
}

/**
 * Storage-usage inspector (sysadmin ops). Rolls up per-namespace byte
 * consumption to inform GC decisions — which prefix is heavy enough to be
 * worth pruning. Read-only; fail-soft when the endpoint isn't deployed (404).
 */
export function StorageUsageModal({ open, onClose }: StorageUsageModalProps) {
  const [storagePrefix, setStoragePrefix] = useState('');
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageResult, setStorageResult] = useState<RegistryStorageUsage | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  const handleStorageUsage = useCallback(async (opts?: { force?: boolean }) => {
    const prefix = storagePrefix.trim();
    if (!prefix) return;
    setStorageLoading(true);
    setStorageError(null);
    try {
      const res = await api.getRegistryStorageUsage(prefix, opts);
      setStorageResult(res.data ?? null);
    } catch (err) {
      setStorageResult(null);
      // Fail-soft: a 404 means the rollup endpoint isn't available in this
      // deployment — surface that plainly rather than as a hard error.
      if (err instanceof ApiError && err.statusCode === 404) {
        setStorageError('Storage rollup is not available in this deployment.');
      } else {
        setStorageError(err instanceof ApiError ? err.message : 'Failed to compute storage usage');
      }
    } finally {
      setStorageLoading(false);
    }
  }, [storagePrefix]);

  if (!open) return null;

  return (
    <Modal
      title="Namespace storage usage"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={() => handleStorageUsage()}
          confirmLabel="Compute"
          confirmVariant="primary"
          loading={storageLoading}
          confirmDisabled={!storagePrefix.trim()}
        />
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-fg-muted">
          Rolls up total unique blob bytes under a single repo namespace prefix
          (e.g. <code className="font-mono">org-acme/</code>) so you can see which
          namespaces are heavy before running GC. The trailing slash is added
          automatically. Results are cached ~60s server-side.
        </p>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-fg-muted">Namespace prefix</label>
          <Input
            type="text"
            placeholder="org-acme/"
            value={storagePrefix}
            onChange={(e) => setStoragePrefix(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && storagePrefix.trim() && !storageLoading) void handleStorageUsage(); }}
            className="text-sm"
            autoFocus
            disabled={storageLoading}
          />
        </div>

        {storageError && (
          <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            {storageError}
          </div>
        )}

        {storageResult && !storageError && (
          <div className="rounded-lg border border-default bg-surface-muted p-3">
            <div className="flex items-baseline justify-between mb-3">
              <code className="font-mono text-sm text-gray-800 dark:text-gray-200">{storageResult.prefix}</code>
              <button
                type="button"
                onClick={() => void handleStorageUsage({ force: true })}
                disabled={storageLoading}
                className="text-xs text-brand hover:underline disabled:opacity-50"
                title="Bypass the server cache and recompute"
              >
                Recompute
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="text-lg font-semibold text-fg tabular-nums">{formatBytes(storageResult.bytes)}</div>
                <div className="text-xs text-fg-muted">total</div>
              </div>
              <div>
                <div className="text-lg font-semibold text-fg tabular-nums">{fmtNum(storageResult.repos)}</div>
                <div className="text-xs text-fg-muted">repos</div>
              </div>
              <div>
                <div className="text-lg font-semibold text-fg tabular-nums">{fmtNum(storageResult.blobs)}</div>
                <div className="text-xs text-fg-muted">unique blobs</div>
              </div>
            </div>
            {storageResult.incomplete && (
              <div className="mt-3 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-200">
                Scan was incomplete — a repo, manifest, or blob could not be read, so this total UNDER-counts actual usage.
              </div>
            )}
            <div className="mt-3 text-xs text-fg-subtle">
              Computed {formatDateTime(storageResult.computedAt)}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
