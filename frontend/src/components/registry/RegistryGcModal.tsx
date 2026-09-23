// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState, useId } from 'react';
import { useToast } from '@/components/ui/Toast';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { api, ApiError } from '@/lib/api';

interface RegistryGcModalProps {
  /** Whether the GC form modal is shown. Kept mounted so the prefix survives close/reopen. */
  open: boolean;
  onClose: () => void;
  /** Called after a REAL (non-dry) run completes — it may have emptied repos. */
  onRealRunComplete: () => void;
}

/**
 * Manual registry GC (sysadmin ops). Defaults to dry-run so an operator
 * validates the candidate set before issuing real DELETEs. Real runs go through
 * an in-app confirm first.
 */
export function RegistryGcModal({ open, onClose, onRealRunComplete }: RegistryGcModalProps) {
  const uid = useId();
  const toast = useToast();
  const [gcPrefix, setGcPrefix] = useState('');
  const [gcDryRun, setGcDryRun] = useState(true);
  const [gcRunning, setGcRunning] = useState(false);
  // Real-run confirmation, shown as an in-app modal.
  const [confirmGc, setConfirmGc] = useState(false);

  const executeGc = useCallback(async () => {
    const prefix = gcPrefix.trim();
    if (!prefix) return;
    setConfirmGc(false);
    setGcRunning(true);
    try {
      const res = await api.runRegistryGc({ prefix, dryRun: gcDryRun });
      const r = res.data;
      if (r) {
        toast.success(
          gcDryRun
            ? `Dry-run: ${r.candidates} candidate${r.candidates === 1 ? '' : 's'} across ${r.reposScanned} repo${r.reposScanned === 1 ? '' : 's'} (nothing deleted)`
            : `GC complete: deleted ${r.deleted} of ${r.candidates} candidate${r.candidates === 1 ? '' : 's'} across ${r.reposScanned} repo${r.reposScanned === 1 ? '' : 's'}`,
        );
      }
      // Close + refresh the repo list only after a real run may have emptied repos.
      if (!gcDryRun) {
        onClose();
        onRealRunComplete();
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Registry GC failed');
    } finally {
      setGcRunning(false);
    }
  }, [gcPrefix, gcDryRun, toast, onClose, onRealRunComplete]);

  // Real runs delete manifests — gate behind an explicit in-app confirm. Dry-runs
  // only walk + count, so they run immediately without the confirm step.
  const handleRunGc = useCallback(() => {
    if (!gcPrefix.trim()) return;
    if (gcDryRun) void executeGc();
    else setConfirmGc(true);
  }, [gcPrefix, gcDryRun, executeGc]);

  return (
    <>
      {open && (
        <Modal
          title="Run registry garbage collection"
          onClose={() => !gcRunning && onClose()}
          footer={
            <ModalFooter
              onCancel={onClose}
              onConfirm={handleRunGc}
              confirmLabel={gcDryRun ? 'Run dry-run' : 'Run GC'}
              confirmVariant={gcDryRun ? 'primary' : 'danger'}
              loading={gcRunning}
              confirmDisabled={!gcPrefix.trim()}
            />
          }
        >
          <div className="space-y-3">
            <p className="text-sm text-fg-muted">
              Prunes manifests older than the retention window under a single repo
              namespace prefix (e.g. <code className="font-mono">org-acme/</code>). The
              trailing slash is added automatically.
            </p>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-namespace-prefix`}>Namespace prefix</label>
              <Input id={`${uid}-namespace-prefix`}
                type="text"
                placeholder="org-acme/"
                value={gcPrefix}
                onChange={(e) => setGcPrefix(e.target.value)}
                className="text-sm"
                autoFocus
                disabled={gcRunning}
              />
            </div>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={gcDryRun}
                onChange={() => setGcDryRun((v) => !v)}
                disabled={gcRunning}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="font-medium text-fg">Dry run</span>
                <span className="block text-fg-subtle">
                  Walk the namespace and count deletion candidates without deleting anything.
                </span>
              </span>
            </label>
          </div>
        </Modal>
      )}

      {confirmGc && (
        <DeleteConfirmModal
          title="Run registry garbage collection"
          itemName={`manifests older than the retention window under "${gcPrefix.trim()}"`}
          loading={gcRunning}
          onConfirm={() => void executeGc()}
          onCancel={() => setConfirmGc(false)}
        />
      )}
    </>
  );
}
