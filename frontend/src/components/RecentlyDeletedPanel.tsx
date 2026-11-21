// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
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
import { visibilityColor } from '@/components/ui/visibility-rungs';
import type { Pipeline, Plugin, Message, PipelineTemplate, Visibility } from '@/types';
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
/** One page request. Ignored by an unpaged loader (its route returns every tombstone). */
interface PageRequest { limit: number; offset: number }

/** One loaded page. `hasMore` is the "ask for the next page" signal. */
interface DeletedPage { rows: DeletedRow[]; hasMore: boolean }

/**
 * Rows per page. The paged list-deleted routes (`parsePaginationParams`:
 * `?limit=&offset=`, default 10) report no total, so the panel asks for a page
 * explicitly and treats a FULL page as "there may be more".
 */
const DELETED_PAGE_SIZE = 25;

/** Wrap a paged list-deleted call (limit/offset contract) into a page loader. */
function paged<T>(
  call: (params: Record<string, string>) => Promise<{ success: boolean; data?: T }>,
  pick: (data: T) => DeletedRow[],
  failure: string,
): (page: PageRequest) => Promise<DeletedPage> {
  return async ({ limit, offset }) => {
    const res = await call({ limit: String(limit), offset: String(offset) });
    if (!res.success || !res.data) throw new Error(failure);
    const rows = pick(res.data);
    return { rows, hasMore: rows.length >= limit };
  };
}

/** Wrap an UNPAGED list-deleted call (the ops-center routes return every
 *  tombstone in one read) — never offers a next page. */
function unpaged<T>(
  call: () => Promise<{ success: boolean; data?: T }>,
  pick: (data: T) => DeletedRow[],
  failure: string,
): (page: PageRequest) => Promise<DeletedPage> {
  return async () => {
    const res = await call();
    if (!res.success || !res.data) throw new Error(failure);
    return { rows: pick(res.data), hasMore: false };
  };
}

interface ResourceConfig {
  labels: { singular: string; plural: string };
  /** Load one page of tombstones; throws on failure so the panel can surface it. */
  load: (page: PageRequest) => Promise<DeletedPage>;
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
    load: paged((params) => api.listDeletedPipelines(params), (d) => d.pipelines.map(pipelineToRow), 'Failed to load deleted pipelines'),
    restore: (id, stepUpToken) => api.restorePipeline(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgePipeline(id, stepUpToken),
  },
  plugin: {
    labels: { singular: 'plugin', plural: 'plugins' },
    load: paged((params) => api.listDeletedPlugins(params), (d) => d.plugins.map(pluginToRow), 'Failed to load deleted plugins'),
    restore: (id, stepUpToken) => api.restorePlugin(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgePlugin(id, stepUpToken),
  },
  template: {
    labels: { singular: 'template', plural: 'templates' },
    load: paged((params) => api.listDeletedTemplates(params), (d) => d.templates.map(templateToRow), 'Failed to load deleted templates'),
    restore: (id, stepUpToken) => api.restorePipelineTemplate(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgePipelineTemplate(id, stepUpToken),
  },
  message: {
    labels: { singular: 'message', plural: 'messages' },
    load: paged((params) => api.listDeletedMessages(params), (d) => d.messages.map(messageToRow), 'Failed to load deleted messages'),
    restore: (id, stepUpToken) => api.restoreMessage(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgeMessage(id, stepUpToken),
  },
  'compliance-rule': {
    labels: { singular: 'rule', plural: 'rules' },
    load: paged((params) => api.listDeletedComplianceRules(params), (d) => d.rules.map(ruleToRow), 'Failed to load deleted rules'),
    restore: (id, stepUpToken) => api.restoreComplianceRule(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgeComplianceRule(id, stepUpToken),
  },
  'compliance-policy': {
    labels: { singular: 'policy', plural: 'policies' },
    load: paged((params) => api.listDeletedCompliancePolicies(params), (d) => d.policies.map(policyToRow), 'Failed to load deleted policies'),
    restore: (id, stepUpToken) => api.restoreCompliancePolicy(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgeCompliancePolicy(id, stepUpToken),
  },
  dashboard: {
    labels: { singular: 'dashboard', plural: 'dashboards' },
    load: unpaged(() => api.listDeletedDashboards(), (d) => d.dashboards.map(dashboardToRow), 'Failed to load deleted dashboards'),
    restore: (id, stepUpToken) => api.restoreDashboard(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgeDashboard(id, stepUpToken),
  },
  'alert-rule': {
    labels: { singular: 'alert rule', plural: 'alert rules' },
    load: unpaged(() => api.listDeletedAlertRules(), (d) => d.rules.map(alertRuleToRow), 'Failed to load deleted alert rules'),
    restore: (id, stepUpToken) => api.restoreAlertRule(id, stepUpToken),
    purge: (id, stepUpToken) => api.purgeAlertRule(id, stepUpToken),
  },
  'alert-destination': {
    labels: { singular: 'alert destination', plural: 'alert destinations' },
    load: unpaged(() => api.listDeletedAlertDestinations(), (d) => d.destinations.map(alertDestinationToRow), 'Failed to load deleted alert destinations'),
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
   *  Restoring a PUBLIC entity needs `:publish` (the restore route's `publishPermission` gate),
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

  // The loaded pages, appended in order. `nextOffset` is where the next page
  // starts on the SERVER: it advances by a page per load and steps back by one
  // for every loaded row this panel restores or purges (each one shifts every
  // later tombstone down a slot), so "Load more" never skips a row.
  const [rows, setRows] = useState<DeletedRow[]>([]);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped whenever the first page is re-read (resource change / retry), so a
  // "Load more" answer for the previous list can't append into the new one.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setRows([]);
    setNextOffset(0);
    setHasMore(false);
    setLoadingMore(false);
  }, [config]);

  const { loading, error: loadErrorFailure, refetch: load } = useFetch<DeletedPage>(
    () => config.load({ limit: DELETED_PAGE_SIZE, offset: 0 }),
    [config],
    {
      onSuccess: (page) => {
        generation.current += 1;
        setRows(page.rows);
        setNextOffset(DELETED_PAGE_SIZE);
        setHasMore(page.hasMore);
      },
      onError: (err) => toast.error(formatError(err, `Failed to load deleted ${labels.plural}`)),
    },
  );
  const loadError = loadErrorFailure ? formatError(loadErrorFailure, `Failed to load deleted ${labels.plural}`) : null;

  const loadMore = async () => {
    const gen = generation.current;
    setLoadingMore(true);
    try {
      const page = await config.load({ limit: DELETED_PAGE_SIZE, offset: nextOffset });
      if (gen !== generation.current) return;
      // De-dupe by id: a deletion made elsewhere since the last page shifts the
      // server's offsets up, re-serving a row this panel already shows.
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...page.rows.filter((r) => !seen.has(r.id))];
      });
      setNextOffset((o) => o + DELETED_PAGE_SIZE);
      setHasMore(page.hasMore);
    } catch (err) {
      if (gen === generation.current) toast.error(formatError(err, `Failed to load more deleted ${labels.plural}`));
    } finally {
      if (gen === generation.current) setLoadingMore(false);
    }
  };

  /** Drop a restored / purged row in place — re-reading page 1 would throw away
   *  every page the user loaded to find it. */
  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    setNextOffset((o) => Math.max(0, o - 1));
  };

  const executeRestore = async (stepUpToken: string) => {
    if (!pendingRestore) return;
    const { id, name } = pendingRestore;
    setRestoring(id);
    try {
      const res = await config.restore(id, stepUpToken);
      if (res.success) {
        toast.success(`Restored ${labels.singular} "${name}"`);
        removeRow(id);
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
  // gone, not returned to the main list; the panel drops the row in place.
  const executePurge = async (stepUpToken: string) => {
    if (!pendingPurge) return;
    const { id, name } = pendingPurge;
    setPurging(id);
    try {
      const res = await config.purge(id, stepUpToken);
      if (res.success) {
        toast.success(`Permanently deleted ${labels.singular} "${name}"`);
        removeRow(id);
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
      render: (r) => (r.visibility ? <Badge color={visibilityColor(r.visibility)}>{r.visibility}</Badge> : null),
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
          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="text-xs text-fg-subtle" role="status">
              Showing {rows.length} deleted {rows.length === 1 ? labels.singular : labels.plural}
              {hasMore ? ' — older deletions are on later pages' : ''}
            </p>
            {hasMore && (
              <Button variant="secondary" size="xs" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
