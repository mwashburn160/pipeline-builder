// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { Cloud, Plus, X, AlertTriangle, Search } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useToast } from '@/components/ui/Toast';
import { formatError } from '@/lib/constants';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ResourceList } from '@/components/ui/ResourceList';
import { FilterInput } from '@/components/ui/FilterInput';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { buildListSummary } from '@/lib/list-summary';
import api from '@/lib/api';
import type { PipelineDeployment } from '@/lib/api/domains/pipelines';
import type { Pipeline } from '@/types';

/**
 * Drift status of a deployed-pipeline registry row relative to the current
 * pipeline configuration. The registry itself carries no version/hash, so
 * "drift" is derived by joining each row's stable `pipelineId` against the live
 * pipeline configs:
 *  - `synced`   — a config with the same id and display name exists.
 *  - `renamed`  — the config exists but its `pipelineName` differs from what
 *                 was registered at deploy time (config edited since deploy).
 *  - `orphaned` — no config with that id exists (config deleted out-of-band),
 *                 so the registry row points at a stack with no definition.
 */
type DriftStatus = 'synced' | 'renamed' | 'orphaned' | 'unknown';

interface DeploymentRow extends PipelineDeployment {
  drift: DriftStatus;
  currentName?: string;
}

// Drift-status filter options. "Needs attention" bundles the two actionable
// states (renamed + orphaned) — the drift banner's quick-filter targets it.
type DriftFilter = 'all' | 'drifted' | 'synced' | 'renamed' | 'orphaned' | 'unknown';
const DRIFT_FILTERS: Array<{ label: string; value: DriftFilter }> = [
  { label: 'All statuses', value: 'all' },
  { label: 'Needs attention', value: 'drifted' },
  { label: 'In sync', value: 'synced' },
  { label: 'Name drift', value: 'renamed' },
  { label: 'Orphaned', value: 'orphaned' },
  { label: 'Unknown', value: 'unknown' },
];

// Sort ordering for the Status column: most-actionable first when ascending.
const DRIFT_RANK: Record<DriftStatus, number> = { orphaned: 0, renamed: 1, unknown: 2, synced: 3 };

// Client-side sort accessors (the registry endpoint doesn't sort server-side,
// and drift is a derived field, so sorting happens over the full fetched set).
const SORT_ACCESSORS: Record<string, (r: DeploymentRow) => string | number> = {
  name: (r) => (r.pipelineName || '').toLowerCase(),
  drift: (r) => DRIFT_RANK[r.drift],
  region: (r) => (r.region || '').toLowerCase(),
  stack: (r) => (r.stackName || '').toLowerCase(),
  lastDeployed: (r) => (r.lastDeployed ? new Date(r.lastDeployed).getTime() : 0),
};

const PAGE_SIZE_DEFAULT = 25;

/**
 * Deployed-pipelines registry page.
 *
 * Lists pipelines that have a live deployment registered (via CDK at deploy
 * time or the register action here), surfaces drift against the current
 * pipeline definitions, and lets a `pipelines:write` user register or
 * deregister deployments. Deregister only clears the platform's record — it
 * never touches the CloudFormation stack.
 *
 * Sorting, the drift filter, search, and pagination are all CLIENT-side: the
 * registry endpoint supports only limit/offset (no sort/search), and drift is
 * derived by joining every row against the current configs — so the page fetches
 * the full set once and operates over it, rather than silently capping at one
 * server page.
 */
export default function DeploymentsPage() {
  const { user, isReady, isSuperAdmin, isOrgAdminUser, isAdmin, can } = useAuthGuard({ requirePermission: 'pipelines:read' });
  const toast = useToast();
  const canWrite = can('pipelines:write');

  const [rows, setRows] = useState<PipelineDeployment[]>([]);
  const [configs, setConfigs] = useState<Pipeline[]>([]);
  // Whether the config fetch actually SUCCEEDED. Distinguishes "no config exists"
  // (→ orphaned) from "we couldn't load configs" (→ unknown). Without this, a
  // transient list-pipelines failure marked every row orphaned and the banner
  // urged deregistering valid records.
  const [configsLoaded, setConfigsLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<DeploymentRow | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Configs (for drift) load in parallel with the registry drain below.
      // Best-effort: a failure just renders every row "unknown" drift (NOT
      // orphaned) rather than blocking the list.
      const cfgPromise = api.listPipelines({ limit: '200', includeTotal: 'false' }).catch(() => null);

      // Drain ALL registry rows (the endpoint is page-limited). Looping until
      // `hasMore` is false avoids the previous silent limit:100 cap; the
      // MAX_PAGES bound is a runaway guard that realistically never trips.
      const PAGE = 200;
      const MAX_PAGES = 50;
      const allRows: PipelineDeployment[] = [];
      let offset = 0;
      let more = true;
      let regFailed = false;
      for (let i = 0; more && i < MAX_PAGES; i++) {
        const regRes = await api.listPipelineDeployments({ limit: PAGE, offset });
        if (!regRes.success || !regRes.data) { regFailed = true; break; }
        const batch = regRes.data.registry;
        allRows.push(...batch);
        more = regRes.data.pagination.hasMore && batch.length > 0;
        offset += batch.length;
      }

      if (regFailed && allRows.length === 0) {
        setError('Failed to load deployments');
      } else {
        setRows(allRows);
      }

      const cfgRes = await cfgPromise;
      if (cfgRes?.success && cfgRes.data) {
        setConfigs(cfgRes.data.pipelines || []);
        setConfigsLoaded(true);
      } else {
        setConfigsLoaded(false);
      }
    } catch (err) {
      setError(formatError(err, 'Failed to load deployments'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isReady) void fetchAll();
  }, [isReady, fetchAll]);

  // Join registry rows against config by pipelineId to derive drift.
  const configById = useMemo(() => {
    const m = new Map<string, Pipeline>();
    for (const c of configs) m.set(c.id, c);
    return m;
  }, [configs]);

  const deploymentRows: DeploymentRow[] = useMemo(() => rows.map((r) => {
    const cfg = configById.get(r.pipelineId);
    let drift: DriftStatus;
    // Can't tell orphaned from valid without configs — don't guess "orphaned".
    if (!configsLoaded) drift = 'unknown';
    else if (!cfg) drift = 'orphaned';
    else if (cfg.pipelineName && r.pipelineName && cfg.pipelineName !== r.pipelineName) drift = 'renamed';
    else drift = 'synced';
    return { ...r, drift, currentName: cfg?.pipelineName };
  }), [rows, configById, configsLoaded]);

  // Only real drift (renamed/orphaned) counts — 'unknown' means we couldn't
  // verify, so it must not inflate the count or trigger the reconcile banner.
  const driftCount = useMemo(() => deploymentRows.filter((r) => r.drift === 'renamed' || r.drift === 'orphaned').length, [deploymentRows]);

  // ── Filters (client-side) ──
  const [search, setSearch] = useState('');
  const [driftFilter, setDriftFilter] = useState<DriftFilter>('all');
  // ── Sort (client-side, external state so it applies BEFORE pagination) ──
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' }>({ col: 'lastDeployed', dir: 'desc' });
  // ── Pagination (client-side over the filtered+sorted set) ──
  const [pageOffset, setPageOffset] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);

  // Any change to what's shown resets to the first page.
  useEffect(() => { setPageOffset(0); }, [search, driftFilter, sort]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return deploymentRows.filter((r) => {
      if (driftFilter === 'drifted' && !(r.drift === 'renamed' || r.drift === 'orphaned')) return false;
      if (driftFilter !== 'all' && driftFilter !== 'drifted' && r.drift !== driftFilter) return false;
      if (!q) return true;
      return (r.pipelineName || '').toLowerCase().includes(q)
        || (r.pipelineId || '').toLowerCase().includes(q)
        || (r.stackName || '').toLowerCase().includes(q)
        || (r.region || '').toLowerCase().includes(q);
    });
  }, [deploymentRows, search, driftFilter]);

  const sortedRows = useMemo(() => {
    const acc = SORT_ACCESSORS[sort.col] ?? SORT_ACCESSORS.lastDeployed;
    const arr = [...filteredRows].sort((a, b) => {
      const av = acc(a);
      const bv = acc(b);
      const r = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.dir === 'asc' ? r : -r;
    });
    return arr;
  }, [filteredRows, sort]);

  // Clamp the offset so a filter that shrank the set doesn't strand an empty page.
  const total = sortedRows.length;
  const clampedOffset = total === 0 ? 0 : Math.min(pageOffset, Math.floor((total - 1) / pageSize) * pageSize);
  const pageRows = useMemo(
    () => sortedRows.slice(clampedOffset, clampedOffset + pageSize),
    [sortedRows, clampedOffset, pageSize],
  );
  const pagination = { limit: pageSize, offset: clampedOffset, total };

  const hasActiveFilters = !!search.trim() || driftFilter !== 'all';
  const summary = useMemo(
    () => buildListSummary(pageRows, total, {
      noun: 'deployment',
      isLoading: loading,
      flags: [{ label: 'needs attention', pred: (r) => r.drift === 'renamed' || r.drift === 'orphaned' }],
    }),
    [pageRows, total, loading],
  );

  const performRemove = async (row: DeploymentRow) => {
    setRemoving(row.id);
    setError(null);
    setConfirmTarget(null);
    try {
      const res = await api.deregisterPipelineDeployment(row.id);
      if (res.success) {
        setRows((prev) => prev.filter((r) => r.id !== row.id));
        toast.success('Deployment deregistered');
      } else {
        setError('Failed to deregister deployment');
      }
    } catch (err) {
      setError(formatError(err, 'Failed to deregister deployment'));
    } finally {
      setRemoving(null);
    }
  };

  // ── Register ──
  const [showRegister, setShowRegister] = useState(false);

  const openRegister = () => setShowRegister(true);

  const handleSort = useCallback((columnId: string, direction: 'asc' | 'desc') => {
    setSort({ col: columnId, dir: direction });
  }, []);

  const columns: Column<DeploymentRow>[] = useMemo(() => [
    {
      id: 'name',
      header: 'Pipeline',
      sortValue: (r) => (r.pipelineName || '').toLowerCase(),
      render: (r) => (
        <div>
          {/* Link to the pipeline detail — except when orphaned (config deleted),
              where the link would 404, so show plain text and let the drift
              badge explain. */}
          {r.drift === 'orphaned' ? (
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{r.pipelineName}</div>
          ) : (
            <Link
              href={`/dashboard/pipelines/${encodeURIComponent(r.pipelineId)}`}
              className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 hover:underline"
            >
              {r.pipelineName}
            </Link>
          )}
          <div className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate max-w-xs">{r.pipelineId}</div>
        </div>
      ),
    },
    {
      id: 'drift',
      header: 'Status',
      sortValue: (r) => DRIFT_RANK[r.drift],
      render: (r) => {
        if (r.drift === 'orphaned') {
          return (
            <span className="inline-flex items-center gap-1" title="No matching pipeline configuration — the config was deleted after this deployment was registered.">
              <Badge color="red">Orphaned</Badge>
            </span>
          );
        }
        if (r.drift === 'renamed') {
          return (
            <span className="inline-flex items-center gap-1" title={`Config renamed since deploy (now "${r.currentName}")`}>
              <Badge color="yellow">Name drift</Badge>
            </span>
          );
        }
        if (r.drift === 'unknown') {
          return (
            <span className="inline-flex items-center gap-1" title="Couldn't load current pipeline configs to compare — drift is unknown, not necessarily out of sync.">
              <Badge color="gray">Unknown</Badge>
            </span>
          );
        }
        return <Badge color="green">In sync</Badge>;
      },
    },
    {
      id: 'region',
      header: 'Region',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (r) => (r.region || '').toLowerCase(),
      render: (r) => <>{r.region || '—'}</>,
    },
    {
      id: 'stack',
      header: 'Stack',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400 font-mono',
      sortValue: (r) => (r.stackName || '').toLowerCase(),
      render: (r) => <>{r.stackName || '—'}</>,
    },
    {
      id: 'lastDeployed',
      header: 'Deployed',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (r) => (r.lastDeployed ? new Date(r.lastDeployed).getTime() : 0),
      render: (r) => <RelativeTime value={r.lastDeployed} />,
    },
    ...(canWrite ? [{
      id: 'actions',
      header: 'Actions',
      render: (r: DeploymentRow) => (
        <button
          onClick={() => setConfirmTarget(r)}
          disabled={removing === r.id}
          className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-600 disabled:opacity-40 disabled:cursor-wait"
          title="Deregister (does not delete the AWS stack)"
          aria-label={`Deregister ${r.pipelineName}`}
        >
          <X className="w-4 h-4" />
        </button>
      ),
    } as Column<DeploymentRow>] : []),
  ], [canWrite, removing]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Deployments"
      subtitle="Pipelines with a live deployment registered, and their drift against current definitions"
      actions={
        canWrite ? (
          <Button onClick={openRegister}>
            <Plus className="w-4 h-4 mr-2" />
            Register deployment
          </Button>
        ) : undefined
        /* Refresh lives on the list card (ResourceList.onRefresh) — no duplicate here. */
      }
    >
      <div className="page-section">
        <RoleBanner isSuperAdmin={isSuperAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="deployments" orgName={user.organizationName} size="sm" />

        {driftCount > 0 && (
          <div className="mb-4 rounded-lg border border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 p-3 flex items-center gap-3 text-sm text-yellow-900 dark:text-yellow-200">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="flex-1">
              {driftCount} deployment{driftCount > 1 ? 's have' : ' has'} drifted from the current pipeline definitions. Orphaned rows point at a stack whose config was deleted; deregister them to reconcile.
            </span>
            {driftFilter !== 'drifted' && (
              <Button variant="secondary" size="sm" onClick={() => setDriftFilter('drifted')}>
                Show drifted
              </Button>
            )}
          </div>
        )}

        {/* Filters only appear once there's something to filter. */}
        {deploymentRows.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[16rem] max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <FilterInput
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by pipeline, stack, or region…"
                aria-label="Search deployments"
                className="pl-9"
              />
            </div>
            <FilterSelect
              value={driftFilter}
              onChange={(e) => setDriftFilter(e.target.value as DriftFilter)}
              aria-label="Filter by drift status"
            >
              {DRIFT_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </FilterSelect>
            {hasActiveFilters && (
              <Button variant="secondary" size="sm" onClick={() => { setSearch(''); setDriftFilter('all'); }}>
                Clear
              </Button>
            )}
            {summary && <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto">{summary}</span>}
          </div>
        )}

        <ResourceList<DeploymentRow>
          loading={loading}
          error={error}
          onRefresh={fetchAll}
          isEmpty={deploymentRows.length === 0}
          pagination={pagination}
          onPageChange={setPageOffset}
          onPageSizeChange={(n) => { setPageSize(n); setPageOffset(0); }}
          errorTitle="Failed to load deployments"
          emptyState={{
            icon: Cloud,
            title: 'No deployed pipelines yet',
            description: (
              <>
                Pipelines register here when <code className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 font-mono text-[0.85em]">pipeline-manager pipeline deploy</code> succeeds, or you register one manually. Once registered, we flag <strong className="font-semibold">drift</strong> — when a pipeline&apos;s config changes or is deleted after deployment — so you can reconcile.
              </>
            ),
            action: canWrite ? <Button onClick={openRegister}>Register deployment</Button> : undefined,
          }}
        >
          <DataTable
            data={pageRows}
            columns={columns}
            isLoading={loading}
            getRowKey={(r) => r.id}
            defaultSortColumn={sort.col}
            defaultSortDirection={sort.dir}
            serverSort
            onSortChange={handleSort}
            emptyState={hasActiveFilters ? {
              icon: Search,
              title: 'No matches',
              description: 'No deployments match your search or filter.',
              action: <Button variant="secondary" onClick={() => { setSearch(''); setDriftFilter('all'); }}>Clear filters</Button>,
            } : {
              icon: Cloud,
              title: 'No deployed pipelines yet',
              description: 'Pipelines register here when a deploy succeeds.',
            }}
          />
        </ResourceList>
      </div>

      {confirmTarget && (
        <Modal title="Deregister deployment" onClose={() => removing ? undefined : setConfirmTarget(null)} maxWidth="max-w-md">
          <div className="space-y-3 text-sm">
            <p className="text-gray-700 dark:text-gray-300">
              Deregister <strong className="font-mono">{confirmTarget.pipelineName}</strong> from the deployments registry?
            </p>
            <div className="p-3 rounded border border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-900 dark:text-yellow-200 text-xs">
              This only removes the platform&apos;s record. It does NOT delete the CloudFormation stack or pipeline. Use this to reconcile drift when the AWS stack was already deleted out-of-band.
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setConfirmTarget(null)} disabled={!!removing}>Cancel</Button>
              <Button variant="danger" onClick={() => performRemove(confirmTarget)} disabled={!!removing}>
                {removing === confirmTarget.id ? 'Removing…' : 'Deregister'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {showRegister && (
        <RegisterDeploymentModal
          configs={configs}
          onClose={() => setShowRegister(false)}
          onRegistered={(row) => {
            // Upsert into the local list so the new/updated row shows without a
            // full refetch (the server upserts by pipelineId).
            setRows((prev) => {
              const rest = prev.filter((r) => r.pipelineId !== row.pipelineId);
              return [row, ...rest];
            });
            setShowRegister(false);
            toast.success('Deployment registered');
          }}
        />
      )}
    </DashboardLayout>
  );
}

/** Modal to register (upsert) a deployment for one of the org's pipelines. */
function RegisterDeploymentModal({
  configs, onClose, onRegistered,
}: {
  configs: Pipeline[];
  onClose: () => void;
  onRegistered: (row: PipelineDeployment) => void;
}) {
  const [pipelineId, setPipelineId] = useState('');
  const [region, setRegion] = useState('');
  const [stackName, setStackName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = configs.find((c) => c.id === pipelineId);

  const handleSubmit = async () => {
    setErr(null);
    if (!pipelineId) {
      setErr('Select a pipeline to register.');
      return;
    }
    if (!selected) {
      setErr('Selected pipeline is no longer available. Refresh and try again.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.registerPipelineDeployment({
        pipelineId,
        pipelineName: selected.pipelineName || pipelineId,
        ...(region.trim() ? { region: region.trim() } : {}),
        ...(selected.project ? { project: selected.project } : {}),
        ...(selected.organization ? { organization: selected.organization } : {}),
        ...(stackName.trim() ? { stackName: stackName.trim() } : {}),
      });
      if (res.success && res.data) {
        onRegistered(res.data.registry);
      } else {
        setErr(formatError(res, 'Failed to register deployment'));
      }
    } catch (e) {
      setErr(formatError(e, 'Failed to register deployment'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Register deployment"
      onClose={() => submitting ? undefined : onClose()}
      maxWidth="max-w-lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting || !pipelineId}>
            {submitting ? 'Registering…' : 'Register'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 text-sm">
        <div>
          <label className="label">Pipeline</label>
          <Select
            value={pipelineId}
            onChange={(e) => { setPipelineId(e.target.value); setErr(null); }}
            disabled={submitting}
          >
            <option value="">Select a pipeline…</option>
            {configs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.pipelineName || c.id}{c.project ? ` — ${c.project}` : ''}
              </option>
            ))}
          </Select>
          {configs.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              No pipeline configurations found. Create a pipeline first.
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Region <span className="text-gray-400">(optional)</span></label>
            <Input
              type="text"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="us-east-1"
              className="text-sm"
              disabled={submitting}
            />
          </div>
          <div>
            <label className="label">Stack name <span className="text-gray-400">(optional)</span></label>
            <Input
              type="text"
              value={stackName}
              onChange={(e) => setStackName(e.target.value)}
              placeholder="my-pipeline-stack"
              className="text-sm"
              disabled={submitting}
            />
          </div>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Registering maps this pipeline&apos;s stable id to its deployment so execution events report against it. Re-registering the same pipeline updates the existing record.
        </p>
        {err && (
          <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3">
            <p className="text-red-800 dark:text-red-300">{err}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
