// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Row selection and the batch activate / deactivate / delete of the "My plugins" list. */

import { useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useRowSelection } from '@/components/dashboard/BulkActionBar';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';

interface Options {
  /** Re-read the list (and drop the cached catalog) after a write. */
  afterWrite: () => void;
  /** Report a failed batch on the list. */
  setError: (msg: string | null) => void;
}

export function usePluginBulkActions({ afterWrite, setError }: Options) {
  const toast = useToast();
  const selection = useRowSelection();
  const { selectedIds, clear: clearSelection } = selection;
  const [bulkLoading, setBulkLoading] = useState(false);
  // Gate bulk delete behind a confirmation modal (mirrors single-row delete's
  // DeleteConfirmModal), since the bulk action is destructive and irreversible.
  const [showBulkDelete, setShowBulkDelete] = useState(false);

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const res = await api.bulkDeletePlugins(Array.from(selectedIds));
      clearSelection();
      setShowBulkDelete(false);
      afterWrite();
      const deleted = res.data?.deleted ?? 0;
      const skipped = res.data?.skipped ?? [];
      if (deleted > 0) toast.success(`${deleted} plugin${deleted > 1 ? 's' : ''} deleted`);
      if (skipped.length > 0) {
        const count = (reason: string) => skipped.filter((s) => s.reason === reason).length;
        const inUseCount = count('in_use');
        const toolchain = count('managed_toolchain');
        const published = skipped.length - inUseCount - toolchain;
        const why = [
          inUseCount > 0 && `${inUseCount} still used by pipelines (delete each on its own to see which, then upgrade them)`,
          published > 0 && `${published} published or under a publish request`,
          toolchain > 0 && `${toolchain} managed toolchain${toolchain === 1 ? '' : 's'} (use the Toolchain console)`,
        ].filter(Boolean).join('; ');
        toast.warning(`${skipped.length} not deleted — ${why}.`, 12000);
      }
    } catch (err) {
      setError(formatError(err, 'Failed to delete plugins'));
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkActivate = async (isActive: boolean) => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const res = await api.bulkUpdatePlugins(Array.from(selectedIds), { isActive });
      clearSelection();
      afterWrite();
      // The server skips frozen/listed versions and managed toolchains rather
      // than failing the batch: report what it actually changed.
      const count = res.data?.updated ?? 0;
      const skipped = res.data?.skipped ?? [];
      const verb = isActive ? 'activated' : 'deactivated';
      if (count > 0) toast.success(`${count} plugin${count === 1 ? '' : 's'} ${verb}`);
      if (skipped.length > 0) {
        const toolchain = skipped.filter((s) => s.reason === 'managed_toolchain').length;
        const frozen = skipped.length - toolchain;
        const why = [
          frozen > 0 && `${frozen} published or under a publish request`,
          toolchain > 0 && `${toolchain} managed toolchain${toolchain === 1 ? '' : 's'} (use the Toolchain console)`,
        ].filter(Boolean).join('; ');
        toast.warning(`${skipped.length} not ${verb} — ${why}.`, 12000);
      }
    } catch (err) {
      setError(formatError(err, `Failed to ${isActive ? 'activate' : 'deactivate'} plugins`));
    } finally {
      setBulkLoading(false);
    }
  };

  return { selection, selectedIds, clearSelection, bulkLoading, showBulkDelete, setShowBulkDelete, handleBulkDelete, handleBulkActivate };
}
