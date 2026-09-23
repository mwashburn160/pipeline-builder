// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BadgeColor } from '@/components/ui/Badge';
import { useCallback, useState } from 'react';
import { History, RotateCcw, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { RetryError } from '@/components/ui/RetryError';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useFetch } from '@/hooks/useFetch';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { Pipeline, Plugin, Message, PipelineTemplate } from '@/types';
import type { ComplianceRule, CompliancePolicy } from '@/types/compliance';
import type { Dashboard, AlertRule, AlertDestination } from '@/types/observability';

/** The subset of a soft-deleted pipeline/plugin the panel renders. */
interface DeletedRow {
  id: string;
  name: string;
  version?: string;
  /** The row's sharing rung, rendered as the "Visibility" badge. */
  visibility?: string;
  /** Author — the restore gate needs it for the author-only `private` rung. */
  createdBy?: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
}

/** Badge tint per sharing level — widest reach is the most prominent. */
const VISIBILITY_BADGE_COLOR: Record<string, BadgeColor> = {
  public: 'blue',
  org: 'green',
  private: 'gray',
};

/**
 * Resources this panel supports. A resource qualifies ONLY if the backend
 * exposes ALL THREE of list-deleted (`GET …/deleted`), restore
 * (`POST …/:id/restore`) and purge (`POST …/:id/purge`) — the panel is
 * list-driven, so a resource with only restore-by-id cannot appear here, and
 * every row offers both actions.
 */
type Resource =
  | 'pipeline' | 'plugin' | 'template' | 'message'
  | 'compliance-rule' | 'compliance-policy'
  | 'dashboard' | 'alert-rule' | 'alert-destination';

/**
 * Per-resource registry: labels + a list-deleted loader (throws on failure so
 * `useFetch` surfaces it) + a step-up-gated restore call. Adding a resource
 * (once its backend grows a list-deleted route) is a single entry here plus a
 * widening of the `Resource` union — no branching in the component body.
 */
interface ResourceConfig {
  labels: { singular: string; plural: string };
  load: () => Promise<DeletedRow[]>;
  restore: (id: string, stepUpToken?: string) => Promise<{ success: boolean }>;
  /** Permanently hard-delete a tombstone before the retention sweep would. Step-up
   *  gated like restore (irreversible destruction): the re-verified token is forwarded. */
  purge: (id: string, stepUpToken?: string) => Promise<{ success: boolean }>;
}

function pipelineToRow(p: Pipeline): DeletedRow {
  return { id: p.id, name: p.pipelineName || p.id, visibility: p.visibility, createdBy: p.createdBy, deletedAt: p.deletedAt, deletedBy: p.deletedBy };
}

function pluginToRow(p: Plugin): DeletedRow {
  return { id: p.id, name: p.name || p.id, version: p.version, visibility: p.visibility, createdBy: p.createdBy, deletedAt: p.deletedAt, deletedBy: p.deletedBy };
}

function templateToRow(t: PipelineTemplate): DeletedRow {
  return { id: t.id, name: t.name || t.id, visibility: t.visibility, createdBy: t.createdBy, deletedAt: t.deletedAt, deletedBy: t.deletedBy };
}

function messageToRow(m: Message): DeletedRow {
  // Messages carry no sharing rung — the Access column renders empty for them.
  return { id: m.id, name: m.subject || m.id, deletedAt: m.deletedAt, deletedBy: m.deletedBy };
}

function ruleToRow(r: ComplianceRule): DeletedRow {
  return { id: r.id, name: r.name || r.id, deletedAt: r.deletedAt, deletedBy: r.deletedBy };
}

function policyToRow(p: CompliancePolicy): DeletedRow {
  return { id: p.id, name: p.name || p.id, deletedAt: p.deletedAt, deletedBy: p.deletedBy };
}

function dashboardToRow(d: Dashboard): DeletedRow {
  // Dashboards ride the same 3-rung visibility ladder as pipelines/plugins, so
  // the Visibility badge is meaningful here.
  return { id: d.id, name: d.name || d.id, visibility: d.visibility, createdBy: d.createdBy, deletedAt: d.deletedAt, deletedBy: d.deletedBy };
}

function alertRuleToRow(r: AlertRule): DeletedRow {
  // Alert rules/destinations are plain per-org rows (no sharing rung) — the
  // Visibility column renders empty for them.
  return { id: r.id, name: r.name || r.id, deletedAt: r.deletedAt, deletedBy: r.deletedBy };
}

function alertDestinationToRow(d: AlertDestination): DeletedRow {
  // Name is the operator's label; the channel qualifies it so two same-labelled
  // destinations are distinguishable. The masked target is deliberately not shown.
  return { id: d.id, name: `${d.label || d.id} (${d.channel})`, deletedAt: d.deletedAt, deletedBy: d.deletedBy };
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
    purge: (id, stepUpToken) => api.purgePipeline(id, stepUpToken),
  },
  plugin: {
    labels: { singular: 'plugin', plural: 'plugins' },
    load: async () => {
      const res = await api.listDeletedPlugins();
      if (res.success && res.data) return res.data.plugins.map(pluginToRow);
      throw new Error('Failed to load deleted plugins');
    },
    restore: (id, stepUpToken) => api.restorePlugin(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgePlugin(id, stepUpToken),
  },
  template: {
    labels: { singular: 'template', plural: 'templates' },
    load: async () => {
      const res = await api.listDeletedTemplates();
      if (res.success && res.data) return res.data.templates.map(templateToRow);
      throw new Error('Failed to load deleted templates');
    },
    restore: (id, stepUpToken) => api.restorePipelineTemplate(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgePipelineTemplate(id, stepUpToken),
  },
  message: {
    labels: { singular: 'message', plural: 'messages' },
    load: async () => {
      const res = await api.listDeletedMessages();
      if (res.success && res.data) return res.data.messages.map(messageToRow);
      throw new Error('Failed to load deleted messages');
    },
    restore: (id, stepUpToken) => api.restoreMessage(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgeMessage(id, stepUpToken),
  },
  'compliance-rule': {
    labels: { singular: 'rule', plural: 'rules' },
    load: async () => {
      const res = await api.listDeletedComplianceRules();
      if (res.success && res.data) return res.data.rules.map(ruleToRow);
      throw new Error('Failed to load deleted rules');
    },
    restore: (id, stepUpToken) => api.restoreComplianceRule(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgeComplianceRule(id, stepUpToken),
  },
  'compliance-policy': {
    labels: { singular: 'policy', plural: 'policies' },
    load: async () => {
      const res = await api.listDeletedCompliancePolicies();
      if (res.success && res.data) return res.data.policies.map(policyToRow);
      throw new Error('Failed to load deleted policies');
    },
    restore: (id, stepUpToken) => api.restoreCompliancePolicy(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgeCompliancePolicy(id, stepUpToken),
  },
  dashboard: {
    labels: { singular: 'dashboard', plural: 'dashboards' },
    load: async () => {
      const res = await api.listDeletedDashboards();
      if (res.success && res.data) return res.data.dashboards.map(dashboardToRow);
      throw new Error('Failed to load deleted dashboards');
    },
    restore: (id, stepUpToken) => api.restoreDashboard(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgeDashboard(id, stepUpToken),
  },
  'alert-rule': {
    labels: { singular: 'alert rule', plural: 'alert rules' },
    load: async () => {
      const res = await api.listDeletedAlertRules();
      if (res.success && res.data) return res.data.rules.map(alertRuleToRow);
      throw new Error('Failed to load deleted alert rules');
    },
    restore: (id, stepUpToken) => api.restoreAlertRule(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgeAlertRule(id, stepUpToken),
  },
  'alert-destination': {
    labels: { singular: 'alert destination', plural: 'alert destinations' },
    load: async () => {
      const res = await api.listDeletedAlertDestinations();
      if (res.success && res.data) return res.data.destinations.map(alertDestinationToRow);
      throw new Error('Failed to load deleted alert destinations');
    },
    restore: (id, stepUpToken) => api.restoreAlertDestination(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgeAlertDestination(id, stepUpToken),
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
  // Hold the row awaiting a purge confirm; the permanent delete runs in executePurge.
  const [pendingPurge, setPendingPurge] = useState<DeletedRow | null>(null);
  const [purging, setPurging] = useState<string | null>(null);

  // Registry-driven loader — each resource's `load` narrows its own response
  // shape and throws on failure so useFetch surfaces it.
  const loader = useCallback(() => config.load(), [config]);
  const { data: rowsLoaded, loading, error: loadErrorFailure, refetch: load } = useFetch<DeletedRow[]>(() => loader(), [loader], {
    onError: (err) => toast.error(formatError(err, `Failed to load deleted ${labels.plural}`)),
  });
  const rows = rowsLoaded ?? [];
  const loadError = loadErrorFailure ? formatError(loadErrorFailure, `Failed to load deleted ${labels.plural}`) : null;

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

  // Purge = permanent hard-delete, step-up gated like restore (the re-verified
  // token is forwarded). Unlike restore it does NOT call onRestored — the item is
  // gone, not returned to the main list; the panel's own `load()` refreshes the list.
  const executePurge = async (stepUpToken: string) => {
    if (!pendingPurge) return;
    const { id, name } = pendingPurge;
    setPurging(id);
    try {
      const res = await config.purge(id, stepUpToken);
      if (res.success) {
        toast.success(`Permanently deleted ${labels.singular} "${name}"`);
        void load();
      } else {
        toast.error(`Failed to purge ${labels.singular}`);
      }
    } catch (err) {
      toast.error(formatError(err, `Failed to purge ${labels.singular}`));
    } finally {
      setPurging(null);
      setPendingPurge(null);
    }
  };

  const columns: Column<DeletedRow>[] = [
    {
      id: 'name',
      header: 'Name',
      cellClassName: 'font-medium text-fg',
      render: (r) => (
        <>{r.name}{r.version ? <span className="ml-1 text-xs text-fg-subtle">v{r.version}</span> : null}</>
      ),
    },
    {
      id: 'visibility',
      header: 'Visibility',
      render: (r) => (r.visibility ? <Badge color={VISIBILITY_BADGE_COLOR[r.visibility] ?? 'gray'}>{r.visibility}</Badge> : null),
    },
    { id: 'deletedAt', header: 'Deleted', render: (r) => (r.deletedAt ? <RelativeTime value={r.deletedAt} /> : <span className="text-fg-subtle">—</span>) },
    { id: 'deletedBy', header: 'Deleted by', cellClassName: 'text-fg-muted text-sm', render: (r) => r.deletedBy || '—' },
    {
      id: 'actions',
      header: '',
      cellClassName: 'text-right',
      // Restore AND purge share the same backend gate — both need `:write`, plus
      // `:publish` for a PUBLIC tombstone. So the per-row publish gate hides BOTH
      // together (a write-but-not-publish user would 403 on either against a public
      // row), keeping the UI honest rather than offering a button that will 403.
      render: (r) => (canRestoreRow && !canRestoreRow(r) ? null : (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setPendingRestore(r)}
            disabled={restoring === r.id}
            className="gap-1 text-brand hover:text-brand-strong"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Restore
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setPendingPurge(r)}
            disabled={purging === r.id}
            className="gap-1 text-danger hover:text-danger-strong"
          >
            <Trash2 className="w-3.5 h-3.5" /> Purge
          </Button>
        </div>
      )),
    },
  ];

  return (
    <Card>
      <div className="flex items-center gap-2 mb-2">
        <History className="w-5 h-5 text-fg-muted" />
        <h2 className="text-lg font-medium text-fg">Recently deleted</h2>
      </div>
      <p className="text-sm text-fg-muted mb-4">
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

      {pendingPurge && (
        <StepUpModal
          action={`Re-confirm your password to PERMANENTLY delete the ${labels.singular} "${pendingPurge.name}". This is irreversible — it cannot be undone.`}
          onConfirmed={executePurge}
          onClose={() => setPendingPurge(null)}
        />
      )}

      {loading && rows.length === 0 ? (
        <p className="text-sm text-fg-subtle" role="status">Loading…</p>
      ) : loadError && rows.length === 0 ? (
        <RetryError message={loadError} onRetry={() => void load()} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-fg-subtle" role="status">No recently deleted {labels.plural}.</p>
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
