// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Execution drill-down — landing target for the home page "Recent runs"
 * card and the sidebar / sidebar links. Member-users want to answer
 * "which of my pipelines is failing today" without scanning the full
 * Reports page; this is the narrow lane for that.
 *
 * The page reads the same `/api/reports/execution/count` endpoint the
 * home stats use, but renders all rows (not just the top 5) with
 * sortable columns + filters. Drilldown deep-links into the existing
 * pipeline detail page.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { EmptyState } from '@/components/ui/EmptyState';
import { Activity, Filter, RefreshCw, XCircle, CheckCircle2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { IngestFreshness } from '@/components/reports/IngestFreshness';
import { useIngestHealth } from '@/components/reports/useReportData';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useOrgHierarchy } from '@/hooks/useOrgHierarchy';
import { useQuery } from '@/hooks/useQuery';
import { useExecutionStatusStream } from '@/hooks/useExecutionStatusStream';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterBar } from '@/components/ui/FilterBar';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { RetryError } from '@/components/ui/RetryError';
import { DateRangePicker } from '@/components/reports/ReportHelpers';
import { PostureHeadline } from '@/components/ui/PostureHeadline';
import { downloadCsv, datedFilename } from '@/lib/csv-export';
import { formatError } from '@/lib/constants';
import { queries } from '@/lib/api-cache';
import type { ExecutionCountRow } from '@/types';

type StatusFilter = 'all' | 'failing' | 'succeeding';

export default function ExecutionsPage() {
  const { accessDenied, isReady, user, can } = useAuthGuard();
  // Is the pipeline that feeds this page alive? Range-independent, read once.
  const ingest = useIngestHealth();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  // Date-range scope (empty = all-time). Both bounds are optional and forwarded
  // to the `getExecutionCount` fetch as `from`/`to`.
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Org → team rollup: only admins/owners can aggregate child-team data, and we
  // only surface the toggle when the org actually parents teams (so flat orgs
  // see no extra control). Backend independently gates the rollup to admins.
  const [includeDescendants, setIncludeDescendants] = useState(false);
  // Gate on the `reports:rollup` permission, not a hardcoded role (parity with reports.tsx).
  const canRollup = can('reports:rollup');

  // Read through the shared query cache — the same `execution/count` read the
  // dashboard home and the inbox make, so a navigation between them is one
  // request, and the key (range + rollup) is the refetch dependency.
  //
  // NOT server-paged, deliberately: this is a per-pipeline AGGREGATE (one row
  // per pipeline, bounded by the org's pipeline count), and the posture headline
  // and stat strip sum over every row — a page would make them lie.
  const countParams: { from?: string; to?: string; includeDescendants?: boolean } = {};
  if (dateFrom) countParams.from = dateFrom;
  if (dateTo) countParams.to = dateTo;
  if (includeDescendants) countParams.includeDescendants = true;
  const { data, loading, error: fetchError, refetch } = useQuery(
    isReady && user ? queries.executionCount(Object.keys(countParams).length ? countParams : undefined) : null,
  );
  const rows = useMemo<ExecutionCountRow[]>(() => data?.data?.pipelines ?? [], [data]);
  const error = fetchError
    ? formatError(fetchError, 'Failed to load executions')
    : data && !data.success ? (data.message || 'Failed to load executions') : null;

  // Live updates: the reporting service pushes an `execution-updated` SSE frame to
  // this org whenever new pipeline events are ingested — refetch on receipt so the
  // table stays current without polling. `refetch` is stable from useQuery.
  const { connected: liveConnected } = useExecutionStatusStream(user?.organizationId ?? null, refetch);

  // The rollup toggle only shows when the active org parents teams.
  const { hasChildOrgs: hasTeams } = useOrgHierarchy();

  // Search scopes everything on the page; the status filter narrows only the
  // table. The stat cards ARE the status filter, so they count over the
  // searched rows — otherwise picking "failing" would zero the "clean" card.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.pipeline_name?.toLowerCase().includes(q) || r.project.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
  }, [rows, search]);

  const filtered = useMemo(() => searched.filter((r) => {
    if (status === 'failing' && r.failed === 0) return false;
    if (status === 'succeeding' && r.failed > 0) return false;
    return true;
  }), [searched, status]);

  const summary = useMemo(() => {
    const totalRuns = searched.reduce((s, r) => s + r.total, 0);
    const totalFailed = searched.reduce((s, r) => s + r.failed, 0);
    const pipelinesWithFailures = searched.filter((r) => r.failed > 0).length;
    const cleanPipelines = searched.length - pipelinesWithFailures;
    return { totalRuns, totalFailed, pipelinesWithFailures, cleanPipelines };
  }, [searched]);

  // Posture: single "how are runs doing?" headline — worst signal wins.
  const successRate = summary.totalRuns > 0 ? Math.round(((summary.totalRuns - summary.totalFailed) / summary.totalRuns) * 100) : 100;
  const posture = summary.totalRuns === 0
    ? { tone: 'gray' as const, Icon: Activity, title: 'No runs yet', detail: 'Pipeline run results will appear here' }
    : summary.totalFailed === 0
      ? { tone: 'green' as const, Icon: CheckCircle2, title: 'All clean', detail: `All ${summary.totalRuns} run${summary.totalRuns === 1 ? '' : 's'} passing` }
      : { tone: (successRate >= 80 ? 'yellow' : 'red') as 'yellow' | 'red', Icon: XCircle, title: `${summary.totalFailed} failed run${summary.totalFailed === 1 ? '' : 's'}`, detail: `across ${summary.pipelinesWithFailures} pipeline${summary.pipelinesWithFailures === 1 ? '' : 's'} · ${successRate}% passing` };

  const columns: Column<ExecutionCountRow>[] = useMemo(() => [
    {
      id: 'name',
      header: 'Pipeline',
      sortValue: (r) => r.pipeline_name || r.project,
      render: (r) => (
        <div>
          <Link
            href={`/dashboard/pipelines/${encodeURIComponent(r.id)}`}
            className="text-sm font-medium text-fg hover:underline"
          >
            {r.pipeline_name || r.project}
          </Link>
          <div className="text-xs text-fg-muted font-mono">{r.project}</div>
        </div>
      ),
    },
    {
      id: 'total',
      header: 'Runs',
      sortValue: (r) => r.total,
      cellClassName: 'text-sm text-fg',
      render: (r) => <>{r.total}</>,
    },
    {
      id: 'succeeded',
      header: 'Passed',
      sortValue: (r) => r.succeeded,
      cellClassName: 'text-sm text-success',
      render: (r) => <>{r.succeeded}</>,
    },
    {
      id: 'failed',
      header: 'Failed',
      sortValue: (r) => r.failed,
      cellClassName: 'text-sm',
      render: (r) => (
        <span className={r.failed > 0 ? 'text-danger font-medium' : 'text-fg-muted'}>
          {r.failed}
        </span>
      ),
    },
    {
      id: 'rate',
      header: 'Success rate',
      sortValue: (r) => (r.total > 0 ? r.succeeded / r.total : -1),
      cellClassName: 'text-sm',
      render: (r) => {
        if (r.total === 0) return <span className="text-fg-subtle">—</span>;
        const pct = Math.round((r.succeeded / r.total) * 100);
        return (
          <Badge color={pct >= 95 ? 'green' : pct >= 80 ? 'yellow' : 'red'}>{pct}%</Badge>
        );
      },
    },
    {
      id: 'last',
      header: 'Last run',
      sortValue: (r) => r.last_execution || '',
      cellClassName: 'text-sm text-fg-muted',
      render: (r) => <RelativeTime value={r.last_execution} />,
    },
  ], []);

  // "Pristine empty" = no runs at all AND no filters applied. In that case the
  // posture banner + 0-value stat cards + search are all noise (three ways of
  // saying "nothing here"), so collapse to a single empty state with a CTA.
  const anyFilterActive = Boolean(search || status !== 'all' || dateFrom || dateTo || includeDescendants);
  const clearFilters = () => {
    setSearch(''); setStatus('all'); setIncludeDescendants(false); setDateFrom(''); setDateTo('');
  };
  const pristineEmpty = !loading && !error && rows.length === 0 && !anyFilterActive;

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Executions"
      subtitle="Pipeline run health across the organization"
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => downloadCsv(
              filtered.map((r) => ({
                pipeline: r.pipeline_name || '',
                project: r.project,
                organization: r.organization,
                total: r.total,
                succeeded: r.succeeded,
                failed: r.failed,
                canceled: r.canceled,
                last_execution: r.last_execution ?? '',
              })),
              ['pipeline', 'project', 'organization', 'total', 'succeeded', 'failed', 'canceled', 'last_execution'],
              datedFilename('executions'),
            )}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1"
            title="Export current view as CSV"
          >
            CSV
          </Button>
          {liveConnected && (
            <span className="inline-flex items-center gap-1.5 text-xs text-success" title="Live — updates automatically as executions complete">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> Live
            </span>
          )}
          <Button variant="secondary" onClick={() => refetch()} className="inline-flex items-center gap-1" disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      }
    >
      {error && <RetryError message={error} onRetry={refetch} className="mb-4" />}

      {/* Ingestion freshness — this page is built entirely from forwarded
          pipeline events, so "No executions yet" is ambiguous on its own: it
          looks the same whether nothing ran or the ingest pipeline is dead.
          The strip says which. It renders nothing until the read lands. */}
      <div className="mb-4">
        <IngestFreshness data={ingest.data} loading={ingest.loading} error={ingest.error} />
      </div>

      {pristineEmpty ? (
        <EmptyState
          icon={Activity}
          title="No executions yet"
          description="Run a pipeline to generate results — run history and pass/fail health show up here."
          action={<Button onClick={() => router.push('/dashboard/pipelines')}>Go to Pipelines</Button>}
        />
      ) : (
      <>
      {/* Posture headline — answers "how are runs doing?" at a glance */}
      <PostureHeadline
        tone={posture.tone}
        Icon={posture.Icon}
        title={posture.title}
        detail={posture.detail}
        rate={summary.totalRuns > 0 ? successRate : undefined}
        className="mb-4"
      />

      {/* Stat strip — one distinct fact per card, and each card IS one value
          of the status filter (all / failing / clean). Failed-run totals live
          in the posture headline above, so they aren't repeated here. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <button
          type="button"
          onClick={() => setStatus('all')}
          aria-pressed={status === 'all'}
          title="Show all pipelines"
          className={`card text-center transition-colors hover:border-default focus:outline-none focus:ring-2 focus:ring-brand ${status === 'all' ? 'ring-1 ring-brand' : ''}`}
        >
          <div className="text-xs text-fg-muted">Total runs</div>
          <div className="text-2xl font-semibold text-fg">{summary.totalRuns}</div>
        </button>
        <button
          type="button"
          onClick={() => setStatus(status === 'failing' ? 'all' : 'failing')}
          aria-pressed={status === 'failing'}
          title={status === 'failing' ? 'Clear filter' : 'Show pipelines with at least one failed run'}
          className={`card text-center transition-colors hover:border-default focus:outline-none focus:ring-2 focus:ring-brand ${status === 'failing' ? 'ring-1 ring-brand' : ''}`}
        >
          <div className="text-xs text-fg-muted">Pipelines with failures</div>
          <div className={`text-2xl font-semibold inline-flex items-center gap-2 ${summary.pipelinesWithFailures > 0 ? 'text-danger' : 'text-fg'}`}>
            {summary.pipelinesWithFailures}
            {summary.pipelinesWithFailures > 0 && <XCircle className="w-5 h-5 text-danger" aria-hidden />}
          </div>
        </button>
        <button
          type="button"
          onClick={() => setStatus(status === 'succeeding' ? 'all' : 'succeeding')}
          aria-pressed={status === 'succeeding'}
          title={status === 'succeeding' ? 'Clear filter' : 'Show pipelines with no failed runs'}
          className={`card text-center transition-colors hover:border-default focus:outline-none focus:ring-2 focus:ring-brand ${status === 'succeeding' ? 'ring-1 ring-brand' : ''}`}
        >
          <div className="text-xs text-fg-muted">All-clean pipelines</div>
          <div className="text-2xl font-semibold text-fg inline-flex items-center gap-2">
            {summary.cleanPipelines}
            {summary.cleanPipelines > 0 && <CheckCircle2 className="w-5 h-5 text-success" aria-hidden />}
          </div>
        </button>
      </div>

      <FilterBar
        sticky
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search pipelines... (press /)"
        showAdvanced={showAdvanced}
        onToggleAdvanced={() => setShowAdvanced(!showAdvanced)}
        advancedFilterCount={(status !== 'all' ? 1 : 0) + (includeDescendants ? 1 : 0) + (dateFrom || dateTo ? 1 : 0)}
        onClearAll={clearFilters}
        advancedContent={
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-fg-subtle" />
              <FilterSelect
                value={status}
                onChange={(e) => setStatus(e.target.value as StatusFilter)}
                aria-label="Filter by pipeline status"
              >
                <option value="all">All pipelines</option>
                <option value="failing">Failing (≥1 fail)</option>
                <option value="succeeding">All-clean</option>
              </FilterSelect>
            </div>
            {/* Date-range scope — empty bounds mean all-time. */}
            <DateRangePicker from={dateFrom} to={dateTo} onFromChange={setDateFrom} onToChange={setDateTo} />
            {canRollup && hasTeams && (
              <label className="inline-flex items-center gap-2 text-sm text-fg" title="Aggregate executions across this organization and its teams">
                <Checkbox
                  checked={includeDescendants}
                  onChange={(e) => setIncludeDescendants(e.target.checked)}
                />
                Include child teams
              </label>
            )}
          </div>
        }
      />

      <DataTable
        data={filtered}
        columns={columns}
        isLoading={loading}
        emptyState={anyFilterActive ? {
          icon: Filter,
          title: 'No executions match these filters',
          description: 'Nothing in this search, status or date range. Clear the filters to see every pipeline.',
          action: <Button variant="secondary" onClick={clearFilters}>Clear filters</Button>,
        } : {
          icon: Activity,
          title: 'No executions yet',
          description: 'Run a pipeline to see results here.',
          action: <Button onClick={() => router.push('/dashboard/pipelines')}>Go to Pipelines</Button>,
        }}
        getRowKey={(r) => r.id}
        defaultSortColumn="last"
        defaultSortDirection="desc"
      />
      </>
      )}
    </DashboardLayout>
  );
}
