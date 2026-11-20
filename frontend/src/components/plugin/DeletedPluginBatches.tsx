// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { Layers, RotateCcw, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import type { Plugin } from '@/types';
import { describeBatchResult, pluginByNameError } from './DeletePluginDialog';

/** One "Delete plugin" action: every version it soft-deleted under one batch id. */
export interface DeletedPluginBatch {
  name: string;
  batchId: string;
  versions: string[];
  deletedAt: string | null;
}

/** Group soft-deleted rows by (name, deleteBatchId); versions deleted on their own carry no batch and are left out. */
export function groupDeletedBatches(rows: ReadonlyArray<Pick<Plugin, 'name' | 'version' | 'deleteBatchId' | 'deletedAt'>>): DeletedPluginBatch[] {
  const byKey = new Map<string, DeletedPluginBatch>();
  for (const r of rows) {
    if (!r.deleteBatchId) continue;
    const key = `${r.name}\u0000${r.deleteBatchId}`;
    const b = byKey.get(key) ?? { name: r.name, batchId: r.deleteBatchId, versions: [], deletedAt: r.deletedAt ?? null };
    b.versions.push(r.version);
    if (r.deletedAt && (!b.deletedAt || r.deletedAt > b.deletedAt)) b.deletedAt = r.deletedAt;
    byKey.set(key, b);
  }
  return [...byKey.values()].sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
}

/**
 * The deleted view's whole-plugin actions: Restore plugin and Purge plugin for
 * each "Delete plugin" batch. Both act on THAT batch only (never on versions
 * deleted earlier on their own) and both need a step-up. The per-version
 * Restore / Purge in Recently deleted below stay as they are.
 */
export function DeletedPluginBatches({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const { data, refetch } = useFetch<DeletedPluginBatch[]>(async () => {
    const res = await api.listDeletedPlugins();
    return groupDeletedBatches(res.data?.plugins ?? []);
  }, []);
  const batches = useMemo(() => data ?? [], [data]);
  const [pending, setPending] = useState<{ kind: 'restore' | 'purge'; batch: DeletedPluginBatch } | null>(null);

  if (batches.length === 0) return null;

  const execute = async (stepUpToken: string) => {
    if (!pending) return;
    const { kind, batch } = pending;
    try {
      const res = kind === 'restore'
        ? await api.restorePluginByName(batch.name, batch.batchId, stepUpToken)
        : await api.purgePluginByName(batch.name, batch.batchId, stepUpToken);
      if (res.data) toast.success(describeBatchResult(kind === 'restore' ? 'Restored' : 'Purged', batch.name, res.data));
      void refetch();
      onChanged?.();
    } catch (err) {
      toast.error(pluginByNameError(err, kind === 'restore' ? 'Failed to restore the plugin' : 'Failed to purge the plugin'));
    } finally {
      setPending(null);
    }
  };

  return (
    <Card className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <Layers className="w-5 h-5 text-fg-muted" aria-hidden />
        <h2 className="text-lg font-medium text-fg">Deleted plugins</h2>
      </div>
      <p className="text-sm text-fg-muted mb-3">
        Every version a &quot;Delete plugin&quot; removed, restorable or purgeable together. Purging removes each version&apos;s
        kept source, image and remediation records for good.
      </p>
      <ul className="divide-y divide-default" aria-label="Deleted plugin batches">
        {batches.map((b) => (
          <li key={`${b.name}:${b.batchId}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="text-sm">
              <span className="font-medium text-fg">{b.name}</span>
              <span className="ml-2 text-xs text-fg-muted">
                {b.versions.length} version{b.versions.length === 1 ? '' : 's'} ({b.versions.join(', ')})
                {b.deletedAt && <> · deleted <RelativeTime value={b.deletedAt} /></>}
              </span>
            </div>
            <div className="flex gap-1">
              <Button variant="ghost" size="xs" className="gap-1 text-brand" onClick={() => setPending({ kind: 'restore', batch: b })}>
                <RotateCcw className="w-3.5 h-3.5" aria-hidden /> Restore plugin
              </Button>
              <Button variant="ghost" size="xs" className="gap-1 text-danger" onClick={() => setPending({ kind: 'purge', batch: b })}>
                <Trash2 className="w-3.5 h-3.5" aria-hidden /> Purge plugin
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {pending && (
        <StepUpModal
          action={pending.kind === 'restore'
            ? `Re-confirm your password to restore the ${pending.batch.versions.length} deleted version(s) of "${pending.batch.name}".`
            : `Re-confirm your password to PERMANENTLY delete the ${pending.batch.versions.length} deleted version(s) of "${pending.batch.name}", with their sources and images. This cannot be undone.`}
          onConfirmed={execute}
          onClose={() => setPending(null)}
        />
      )}
    </Card>
  );
}
