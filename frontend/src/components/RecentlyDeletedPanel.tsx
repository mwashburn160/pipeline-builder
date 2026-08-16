// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useLoadable } from '@/hooks/useLoadable';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { Pipeline, Plugin, Message } from '@/types';
import type { ComplianceRule, CompliancePolicy } from '@/types/compliance';

/** The subset of a soft-deleted pipeline/plugin the panel renders. */
interface DeletedRow {
  id: string;
  name: string;
  version?: string;
  accessModifier?: string;
  deletedAt?: string;
  deletedBy?: string;
}

/**
 * Resources this panel supports. A resource qualifies ONLY if the backend
 * exposes BOTH a list-deleted (`GET …/deleted`) route AND a restore
 * (`POST …/:id/restore`) route — the panel is list-driven, so a resource with
 * only restore-by-id cannot appear here.
 */
type Resource = 'pipeline' | 'plugin' | 'message' | 'compliance-rule' | 'compliance-policy';

/**
 * Per-resource registry: labels + a list-deleted loader (throws on failure so
 * `useLoadable` surfaces it) + a step-up-gated restore call. Adding a resource
 * (once its backend grows a list-deleted route) is a single entry here plus a
 * widening of the `Resource` union — no branching in the component body.
 */
interface ResourceConfig {
  labels: { singular: string; plural: string };
  load: () => Promise<DeletedRow[]>;
  restore: (id: string, stepUpToken?: string) => Promise<{ success: boolean }>;
}

function pipelineToRow(p: Pipeline): DeletedRow {
  return { id: p.id, name: p.pipelineName || p.id, accessModifier: p.accessModifier, deletedAt: p.deletedAt, deletedBy: p.deletedBy };
}

function pluginToRow(p: Plugin): DeletedRow {
  return { id: p.id, name: p.name || p.id, version: p.version, accessModifier: p.accessModifier, deletedAt: p.deletedAt, deletedBy: p.deletedBy };
}

function messageToRow(m: Message): DeletedRow {
  return { id: m.id, name: m.subject || m.id, accessModifier: m.accessModifier, deletedAt: m.deletedAt, deletedBy: m.deletedBy };
}

function ruleToRow(r: ComplianceRule): DeletedRow {
  return { id: r.id, name: r.name || r.id, deletedAt: r.deletedAt, deletedBy: r.deletedBy };
}

function policyToRow(p: CompliancePolicy): DeletedRow {
  return { id: p.id, name: p.name || p.id, deletedAt: p.deletedAt, deletedBy: p.deletedBy };
}

const RESOURCES: Record<Resource, ResourceConfig> = {
  pipeline: {
    labels: { singular: 'pipeline', plural: 'pipelines' },
    load: async () => {
      const res = await api.listDeletedPipelines();
      if (res.success && res.data) return res.data.pipelines.map(pipelineToRow);
      throw new Error('Failed to load deleted pipelines');
    },
    restore: (id, stepUpToken) => api.restorePipeline(id, stepUpToken),
  },
  plugin: {
    labels: { singular: 'plugin', plural: 'plugins' },
    load: async () => {
      const res = await api.listDeletedPlugins();
      if (res.success && res.data) return res.data.plugins.map(pluginToRow);
      throw new Error('Failed to load deleted plugins');
    },
    restore: (id, stepUpToken) => api.restorePlugin(id, stepUpToken),
  },
  message: {
    labels: { singular: 'message', plural: 'messages' },
    load: async () => {
      const res = await api.listDeletedMessages();
      if (res.success && res.data) return res.data.messages.map(messageToRow);
      throw new Error('Failed to load deleted messages');
    },
    restore: (id, stepUpToken) => api.restoreMessage(id, stepUpToken),
  },
  'compliance-rule': {
    labels: { singular: 'rule', plural: 'rules' },
    load: async () => {
      const res = await api.listDeletedComplianceRules();
      if (res.success && res.data) return res.data.rules.map(ruleToRow);
      throw new Error('Failed to load deleted rules');
    },
    restore: (id, stepUpToken) => api.restoreComplianceRule(id, stepUpToken),
  },
  'compliance-policy': {
    labels: { singular: 'policy', plural: 'policies' },
    load: async () => {
      const res = await api.listDeletedCompliancePolicies();
      if (res.success && res.data) return res.data.policies.map(policyToRow);
      throw new Error('Failed to load deleted policies');
    },
    restore: (id, stepUpToken) => api.restoreCompliancePolicy(id, stepUpToken),
  },
};

/**
 * "Recently deleted" restore panel for a resource kind. Lists the org's
 * soft-deleted tombstones (still within the retention window, before the purge
 * sweep hard-deletes them) and lets a user restore one. Restore reverses a
 * destructive action, so it's step-up gated: clicking Restore opens the
 * StepUpModal and the re-verified token is forwarded to the restore endpoint.
 */
export function RecentlyDeletedPanel({ resource, canRestoreRow, onRestored }: {
  resource: Resource;
  /** Optional per-row gate mirroring the list page's row-level write check.
   *  Restoring a PUBLIC entity needs `:publish` (backend `requirePublicAccess`),
   *  so a write-but-not-publish user should not see Restore on a public tombstone
   *  (else they get a 403 after the password prompt). Defaults to always-allowed. */
  canRestoreRow?: (row: DeletedRow) => boolean;
  /** Called after a successful restore so the mounting page can refresh its
   *  main list — a restored entity reappears there, so without this the page
   *  shows a stale list until the next manual reload. */
  onRestored?: () => void;
}) {
  const toast = useToast();
  const config = RESOURCES[resource];
  const { labels } = config;
  const [restoring, setRestoring] = useState<string | null>(null);
  // Hold the row awaiting a step-up re-verify; the restore runs in executeRestore.
  const [pendingRestore, setPendingRestore] = useState<DeletedRow | null>(null);

  // Registry-driven loader — each resource's `load` narrows its own response
  // shape and throws on failure so useLoadable surfaces it.
  const loader = useCallback(() => config.load(), [config]);
  const { data: rows, loading, error: loadError, reload: load } = useLoadable<DeletedRow[]>(loader, [], `Failed to load deleted ${labels.plural}`);

  const executeRestore = async (stepUpToken: string) => {
    if (!pendingRestore) return;
    const { id, name } = pendingRestore;
    setRestoring(id);
    try {
      const res = await config.restore(id, stepUpToken);
      if (res.success) {
        toast.success(`Restored ${labels.singular} "${name}"`);
        void load();
        // Refresh the mounting page's main list — the restored entity reappears
        // there, so skipping this leaves it showing a stale list.
        onRestored?.();
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
