// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react';
import { Lock, Users } from 'lucide-react';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LinkButton } from '@/components/ui/LinkButton';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { FEATURE_METADATA } from '@/lib/feature-flags';
import { formatDurationSeconds } from '@/lib/format';
import { useFetch } from '@/hooks/useFetch';
import type { DoraLevel } from '@/lib/api/domains/reporting';
import type { TeamBenchmarkRow } from '@/lib/api/domains/reporting-benchmark';
import { DoraLevelBadge, DoraCountingNote, fmtWindow } from '../DoraParts';
import { ExportCSVButton, SectionCardSkeleton, SectionHeading } from '../ReportHelpers';
import { useReportBucketing, type SharedFilters, type TabDataStatus } from '../useReportData';

interface TeamsTabProps {
  filters: SharedFilters;
  /** Whether `advanced_reporting` is entitled — non-entitled renders the upsell and fetches nothing. */
  enabled: boolean;
  /** Whether the viewer holds `reports:rollup` (looking down into the teams) — without it nothing is fetched. */
  canRollup: boolean;
  onStatus: (status: TabDataStatus) => void;
}

/** The sortable columns. */
export type TeamSortKey = 'name' | 'deployFrequency' | 'changeFailureRate' | 'leadTime' | 'timeToRestore' | 'successRate' | 'runs';

/** Display name: the team's name, else its id. */
const nameOf = (r: TeamBenchmarkRow) => r.name ?? r.orgId;

/** A row's value for a column; null = no value (sorts last either way). */
export function sortValue(r: TeamBenchmarkRow, key: TeamSortKey): number | string | null {
  switch (key) {
    case 'name': return nameOf(r).toLowerCase();
    case 'deployFrequency': return r.deploymentFrequency?.value.perDay ?? null;
    case 'changeFailureRate': return r.changeFailureRate && r.changeFailureRate.value.attempts > 0 ? r.changeFailureRate.value.rate : null;
    case 'leadTime': return r.leadTime?.value.medianSeconds ?? null;
    case 'timeToRestore': return r.timeToRestore?.value.medianSeconds ?? null;
    case 'successRate': return r.successRate?.pct ?? null;
    case 'runs': return r.successRate?.runs ?? null;
  }
}

/**
 * Sort the rows by one column. The parent org stays pinned first (it is the
 * reference the teams are read against); rows with no value sort last in both
 * directions so "best first" never leads with a blank.
 */
export function sortTeamRows(rows: readonly TeamBenchmarkRow[], key: TeamSortKey, dir: 'asc' | 'desc'): TeamBenchmarkRow[] {
  const parent = rows.filter((r) => r.role === 'parent');
  const teams = rows.filter((r) => r.role !== 'parent');
  const sign = dir === 'asc' ? 1 : -1;
  teams.sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va == null && vb == null) return nameOf(a).localeCompare(nameOf(b));
    if (va == null) return 1;
    if (vb == null) return -1;
    if (va < vb) return -sign;
    if (va > vb) return sign;
    return nameOf(a).localeCompare(nameOf(b));
  });
  return [...parent, ...teams];
}

/** One flat CSV record per team (the table's figures, with each band and n). */
export function teamCsvRows(rows: readonly TeamBenchmarkRow[]): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    team: nameOf(r),
    org_id: r.orgId,
    role: r.role,
    state: r.state,
    environment: r.environment ?? '',
    deployments: r.deploymentFrequency?.value.deployments ?? '',
    deploys_per_day: r.deploymentFrequency?.value.perDay ?? '',
    deploy_frequency_band: r.deploymentFrequency?.level ?? '',
    deploy_frequency_n: r.deploymentFrequency?.n ?? '',
    change_failure_rate_pct: r.changeFailureRate?.value.rate ?? '',
    change_failure_band: r.changeFailureRate?.level ?? '',
    change_failure_n: r.changeFailureRate?.n ?? '',
    lead_time_median_seconds: r.leadTime?.value.medianSeconds ?? '',
    lead_time_band: r.leadTime?.level ?? '',
    lead_time_n: r.leadTime?.n ?? '',
    time_to_restore_median_seconds: r.timeToRestore?.value.medianSeconds ?? '',
    time_to_restore_band: r.timeToRestore?.level ?? '',
    time_to_restore_n: r.timeToRestore?.n ?? '',
    success_rate_pct: r.successRate?.pct ?? '',
    runs: r.successRate?.runs ?? '',
  }));
}

/** The locked state, matching the DORA / Security upsell: same lock, same CTA. Nothing behind it is real data. */
export function TeamsUpsell() {
  const meta = FEATURE_METADATA.advanced_reporting;
  return (
    <div>
      <SectionHeading>Team benchmarking</SectionHeading>
      <div className="relative overflow-hidden rounded-lg border border-default">
        <div className="p-4 blur-[3px] opacity-60 select-none pointer-events-none" aria-hidden="true">
          <table className="w-full text-sm">
            <tbody>
              {['Team A', 'Team B', 'Team C'].map((t) => (
                <tr key={t}><td>{t}</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface/70 backdrop-blur-[1px] px-6 py-8 text-center">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-info-bg text-brand">
            <Lock className="w-5 h-5" aria-hidden="true" />
          </span>
          <h4 className="text-base font-semibold text-fg">{meta.label} &mdash; team benchmarking</h4>
          <p className="max-w-md text-sm text-fg-muted">
            Compare deployment frequency, change failure rate, lead time, time to restore and success rate
            across your organization&apos;s teams. {meta.description}.
          </p>
          <LinkButton href="/dashboard/usage?tab=billing&highlight=advanced_reporting" size="sm" className="mt-1">
            Unlock Advanced Reporting
          </LinkButton>
        </div>
      </div>
    </div>
  );
}

const COLUMNS: Array<{ key: TeamSortKey; label: string; numeric?: boolean }> = [
  { key: 'name', label: 'Team' },
  { key: 'deployFrequency', label: 'Deploy frequency', numeric: true },
  { key: 'changeFailureRate', label: 'Change failure rate', numeric: true },
  { key: 'leadTime', label: 'Lead time', numeric: true },
  { key: 'timeToRestore', label: 'Time to restore', numeric: true },
  { key: 'successRate', label: 'Success rate', numeric: true },
  { key: 'runs', label: 'Runs', numeric: true },
];

/** A DORA cell: the value and its band chip (or "Not enough data (n = X)"). */
function Cell({ text, level, n }: { text: string; level: DoraLevel; n: number }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="tabular-nums">{text}</span>
      <DoraLevelBadge level={level} n={n} />
    </span>
  );
}

/** The benchmark table: sortable headers (`aria-sort`), parent pinned first. */
export function TeamsTable({ rows }: { rows: TeamBenchmarkRow[] }) {
  const [sortKey, setSortKey] = useState<TeamSortKey>('name');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const sorted = useMemo(() => sortTeamRows(rows, sortKey, dir), [rows, sortKey, dir]);
  const onSort = (key: TeamSortKey) => {
    if (key === sortKey) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">DORA and success-rate benchmark per team</caption>
        <thead>
          <tr className="text-left text-xs text-fg-subtle border-b border-default">
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                scope="col"
                className="py-2 pr-3 font-medium"
                aria-sort={sortKey === c.key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                <button type="button" className="inline-flex items-center gap-1 hover:text-fg" onClick={() => onSort(c.key)}>
                  {c.label}
                  <span aria-hidden="true">{sortKey === c.key ? (dir === 'asc' ? '▲' : '▼') : ''}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.orgId} className="border-b border-default last:border-0 align-top">
              <th scope="row" className="py-2 pr-3 font-medium text-fg text-left">
                {nameOf(r)}
                {r.role === 'parent' && <span className="ml-1 text-2xs text-fg-subtle font-normal">(this organization)</span>}
              </th>
              {r.state === 'failed' ? (
                <td colSpan={COLUMNS.length - 1} className="py-2 pr-3 text-xs text-danger">Could not load this team&apos;s figures.</td>
              ) : (
                <>
                  <td className="py-2 pr-3">
                    {r.deploymentFrequency
                      ? <Cell text={`${r.deploymentFrequency.value.perDay.toFixed(2)}/day`} level={r.deploymentFrequency.level} n={r.deploymentFrequency.n} />
                      : <span className="text-fg-subtle">No deploys</span>}
                  </td>
                  <td className="py-2 pr-3">
                    {r.changeFailureRate && r.changeFailureRate.value.attempts > 0
                      ? <Cell text={`${r.changeFailureRate.value.rate}%`} level={r.changeFailureRate.level} n={r.changeFailureRate.n} />
                      : <span className="text-fg-subtle">—</span>}
                  </td>
                  <td className="py-2 pr-3">
                    {r.leadTime
                      ? <Cell text={r.leadTime.value.medianSeconds == null ? 'unknown' : formatDurationSeconds(r.leadTime.value.medianSeconds)} level={r.leadTime.level} n={r.leadTime.n} />
                      : <span className="text-fg-subtle">—</span>}
                  </td>
                  <td className="py-2 pr-3">
                    {r.timeToRestore
                      ? <Cell text={formatDurationSeconds(r.timeToRestore.value.medianSeconds)} level={r.timeToRestore.level} n={r.timeToRestore.n} />
                      : <span className="text-fg-subtle">—</span>}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{r.successRate?.pct == null ? '—' : `${r.successRate.pct}%`}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.successRate?.runs ?? 0}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * Teams top-tab (`advanced_reporting` + `reports:rollup`): one row per team in
 * the org → team hierarchy, plus the org itself, each built from the team's own
 * dashboard reads (so a row equals that team's DORA and Pipelines tabs). Team
 * level only — never per person. Non-entitled → the upsell; no `reports:rollup`
 * → a note; neither fetches.
 */
export function TeamsTab({ filters, enabled, canRollup, onStatus }: TeamsTabProps) {
  const bucketing = useReportBucketing();
  const params = useMemo(() => ({
    ...(filters.dateFrom ? { from: filters.dateFrom } : {}),
    ...(filters.dateTo ? { to: filters.dateTo } : {}),
    interval: filters.interval,
    tz: bucketing.tz,
    ...(bucketing.weekStart ? { weekStart: bucketing.weekStart } : {}),
  }), [filters.dateFrom, filters.dateTo, filters.interval, bucketing.tz, bucketing.weekStart]);
  const key = JSON.stringify(params);
  const active = enabled && canRollup && bucketing.ready;

  const bench = useFetch(
    (signal) => (active ? api.getTeamBenchmark(params, { signal }) : Promise.resolve(null)), [active, key],
  );
  const loading = enabled && canRollup && (!bucketing.ready || bench.loading);
  const error = bench.error ? formatError(bench.error, 'Failed to load the team benchmark') : null;
  const { refetch } = bench;
  useEffect(() => {
    onStatus({ loading, error, refetch: () => { void refetch(); } });
  }, [loading, error, refetch, onStatus]);

  if (!enabled) return <TeamsUpsell />;
  if (!canRollup) {
    return (
      <Callout variant="info" title="Team benchmarking needs the reports:rollup permission">
        Comparing teams means looking into each team&apos;s figures, which the reports:rollup permission grants
        (built-in Admin and Owner roles carry it). Ask an organization admin to add it to one of your Roles.
      </Callout>
    );
  }
  if (loading && !bench.data) return <SectionCardSkeleton lines={5} />;
  const data = bench.data;
  if (!data) return null;
  if (!data.hasTeams) {
    return (
      <EmptyState
        icon={Users}
        title="No teams yet"
        description="This organization has no teams to compare. Create teams under your organization to benchmark their delivery performance side by side."
        illustration="default"
      />
    );
  }

  return (
    <section aria-label="Team benchmarking">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionHeading>Team benchmarking</SectionHeading>
        <ExportCSVButton data={teamCsvRows(data.rows)} filename="team-benchmark" />
      </div>
      <p className="-mt-1 mb-3 text-xs text-fg-subtle">
        {data.window && fmtWindow(data.window.dora)} &middot; each row is that team&apos;s own figures (its DORA and
        Pipelines tabs show the same numbers); this organization&apos;s row excludes its teams. DORA cells describe the
        headline environment.
      </p>
      <TeamsTable rows={data.rows} />
      <DoraCountingNote />
    </section>
  );
}
