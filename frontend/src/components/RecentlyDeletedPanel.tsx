// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { Pipeline, Plugin } from '@/types';

/** The subset of a soft-deleted pipeline/plugin the panel renders. */
interface DeletedRow {
  id: string;
  name: string;
  version?: string;
  accessModifier?: string;
  deletedAt?: string;
  deletedBy?: string;
}

type Resource = 'pipeline' | 'plugin';

const LABELS: Record<Resource, { singular: string; plural: string }> = {
  pipeline: { singular: 'pipeline', plural: 'pipelines' },
  plugin: { singular: 'plugin', plural: 'plugins' },
};

function toRow(resource: Resource, item: Pipeline | Plugin): DeletedRow {
  if (resource === 'pipeline') {
    const p = item as Pipeline;
    return { id: p.id, name: p.pipelineName || p.id, accessModifier: p.accessModifier, deletedAt: p.deletedAt, deletedBy: p.deletedBy };
  }
  const p = item as Plugin;
  return { id: p.id, name: p.name || p.id, version: p.version, accessModifier: p.accessModifier, deletedAt: p.deletedAt, deletedBy: p.deletedBy };
}

/**
 * "Recently deleted" restore panel for a resource kind. Lists the org's
 * soft-deleted tombstones (still within the retention window, before the purge
 * sweep hard-deletes them) and lets a user restore one. Restore reverses a
 * destructive action, so it's step-up gated: clicking Restore opens the
 * StepUpModal and the re-verified token is forwarded to the restore endpoint.
 */
export function RecentlyDeletedPanel({ resource, canRestoreRow }: {
  resource: Resource;
  /** Optional per-row gate mirroring the list page's row-level write check.
   *  Restoring a PUBLIC entity needs `:publish` (backend `requirePublicAccess`),
   *  so a write-but-not-publish user should not see Restore on a public tombstone
   *  (else they get a 403 after the password prompt). Defaults to always-allowed. */
  canRestoreRow?: (row: DeletedRow) => boolean;
}) {
  const toast = useToast();
  const labels = LABELS[resource];
  const [rows, setRows] = useState<DeletedRow[]>([]);
  // Starts true: the load runs in a post-paint effect, so init-false would flash
  // the "No recently deleted" empty state for one frame on every mount.
  const [loading, setLoading] = useState(true);
  // A load failure must NOT render as an empty "nothing deleted" state — that
  // would falsely imply there's nothing to restore.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  // Hold the row awaiting a step-up re-verify; the restore runs in executeRestore.
  const [pendingRestore, setPendingRestore] = useState<DeletedRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Branch per resource so each response's `data` narrows to a concrete
      // shape ({ pipelines } vs { plugins }) instead of a union.
      if (resource === 'pipeline') {
        const res = await api.listDeletedPipelines();
        if (res.success && res.data) setRows(res.data.pipelines.map((i) => toRow('pipeline', i)));
        else setLoadError(`Failed to load deleted ${labels.plural}`);
      } else {
        const res = await api.listDeletedPlugins();
        if (res.success && res.data) setRows(res.data.plugins.map((i) => toRow('plugin', i)));
        else setLoadError(`Failed to load deleted ${labels.plural}`);
      }
    } catch (err) {
      const msg = formatError(err, `Failed to load deleted ${labels.plural}`);
      setLoadError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [resource, labels.plural, toast]);

  useEffect(() => { void load(); }, [load]);

  const executeRestore = async (stepUpToken: string) => {
    if (!pendingRestore) return;
    const { id, name } = pendingRestore;
    setRestoring(id);
    try {
      const res = resource === 'pipeline'
        ? await api.restorePipeline(id, stepUpToken)
        : await api.restorePlugin(id, stepUpToken);
      if (res.success) {
        toast.success(`Restored ${labels.singular} "${name}"`);
        void load();
      } else {
        toast.error(`Failed to restore ${labels.singular}`);
      }
    } catch (err) {
      toast.error(formatError(err, `Failed to restore ${labels.singular}`));
    } finally {
      setRestoring(null);
      setPendingRestore(null);
    }
  };

  const columns: Column<DeletedRow>[] = [
    {
      id: 'name',
      header: 'Name',
      cellClassName: 'font-medium text-gray-900 dark:text-gray-100',
      render: (r) => (
        <>{r.name}{r.version ? <span className="ml-1 text-xs text-gray-400">v{r.version}</span> : null}</>
      ),
    },
    {
      id: 'access',
      header: 'Access',
      render: (r) => (r.accessModifier ? <Badge color={r.accessModifier === 'public' ? 'blue' : 'gray'}>{r.accessModifier}</Badge> : null),
    },
    { id: 'deletedAt', header: 'Deleted', render: (r) => (r.deletedAt ? <RelativeTime value={r.deletedAt} /> : <span className="text-gray-400">—</span>) },
    { id: 'deletedBy', header: 'Deleted by', cellClassName: 'text-gray-600 dark:text-gray-400 text-sm', render: (r) => r.deletedBy || '—' },
    {
      id: 'actions',
      header: '',
      cellClassName: 'text-right',
      render: (r) => (canRestoreRow && !canRestoreRow(r) ? null : (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setPendingRestore(r)}
          disabled={restoring === r.id}
          className="gap-1 text-blue-600 hover:text-blue-700"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Restore
        </Button>
      )),
    },
  ];

  return (
    <Card>
      <div className="flex items-center gap-2 mb-2">
        <History className="w-5 h-5 text-gray-500" />
        <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">Recently deleted</h2>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Soft-deleted {labels.plural} are kept for a retention window and can be restored until they&apos;re
        permanently purged. Restoring re-verifies your password.
      </p>

      {pendingRestore && (
        <StepUpModal
          action={`Re-confirm your password to restore the ${labels.singular} "${pendingRestore.name}".`}
          onConfirmed={executeRestore}
          onClose={() => setPendingRestore(null)}
        />
      )}

      {loading && rows.length === 0 ? (
        <p className="text-sm text-gray-400" role="status">Loading…</p>
      ) : loadError && rows.length === 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => void load()} className="underline hover:no-underline shrink-0">Retry</button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-400" role="status">No recently deleted {labels.plural}.</p>
      ) : (
        <div className="overflow-x-auto">
          {/* Loading/error/empty are handled by the branches above; DataTable only
              renders with rows. emptyState is a required prop (kept as a fallback). */}
          <DataTable
            data={rows}
            columns={columns}
            isLoading={false}
            animated={false}
            getRowKey={(r) => r.id}
            emptyState={{ icon: History, title: `No recently deleted ${labels.plural}`, description: `Deleted ${labels.plural} still within the retention window appear here.` }}
          />
        </div>
      )}
    </Card>
  );
}
