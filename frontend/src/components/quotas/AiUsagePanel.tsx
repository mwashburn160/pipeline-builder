// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { InfoAlert } from '@/components/ui/InfoAlert';
import { StatCard } from '@/components/ui/StatCard';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useReportBucketing } from '@/components/reports/useReportData';
import { formatError } from '@/lib/constants';
import { triggerBlobDownload } from '@/lib/download';
import { fmtNum, formatDate } from '@/lib/format';
import api from '@/lib/api';
import type { AiCallerType, AiReportFeature, AiUsageInterval, AiUsageReport, AiUsageReportParams } from '@/types/ai-usage';

/** Feature labels — keyed by the server's catalog, so a new key fails to compile here. */
export const AI_FEATURE_LABEL: Record<AiReportFeature, string> = {
  ask: 'Ask (how-to answers)',
  agent: 'Ask agent',
  'agent-tool': 'Ask agent tools',
  'pipeline-generate': 'Pipeline generation',
  'plugin-generate': 'Plugin generation',
  'report-summary': 'Report summary',
  other: 'Other',
};

const CALLER_LABEL: Record<AiCallerType, string> = {
  user: 'User sessions',
  service_account: 'Service accounts',
  system: 'System',
};

const RANGES = [7, 30, 90] as const;

/** The empty state of the acceptance half: it is recorded from this release on. */
const ACCEPTANCE_STARTS = 'Draft acceptance starts with this release: AI drafts accepted, edited then accepted, or discarded from now on are counted here. Usage is shown for the whole range.';

/** `0.75` → `75%`; null (no outcomes) → `—`. */
function pct(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/** One small table: a header row and one row per item. */
function SliceTable<T>({ caption, columns, rows, rowKey }: {
  caption: string;
  columns: Array<{ label: string; cell: (row: T) => ReactNode; numeric?: boolean }>;
  rows: T[];
  rowKey: (row: T) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="text-left text-xs font-semibold text-fg-muted mb-1">{caption}</caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-fg-subtle">
            {columns.map((c, i) => (
              <th key={c.label} scope="col" className={`py-1.5 font-semibold ${i === 0 ? 'pr-3' : 'px-3'} ${c.numeric ? 'text-right' : ''}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className="border-t border-default">
              {columns.map((c, i) => (
                <td key={c.label} className={`py-1.5 ${i === 0 ? 'pr-3' : 'px-3'} ${c.numeric ? 'text-right tabular-nums' : ''}`}>{c.cell(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The AI assistant usage report — beside "What used this" on the quotas page,
 * behind the same `quotas:read`. AI calls per day or week (in the org's
 * reporting timezone), by caller type, by feature and — for a `reports:rollup`
 * holder at an account root — by team, plus how often AI-generated drafts were
 * accepted, edited then accepted, or discarded. Never per person. CSV export of
 * the same rows.
 */
export function AiUsagePanel({ orgId, isTeam }: {
  orgId: string;
  /** The org is a team: no team rollup is offered. */
  isTeam: boolean;
}) {
  const { can } = useAuthGuard();
  const canRollup = !isTeam && can('reports:rollup');
  const [rangeDays, setRangeDays] = useState<number>(30);
  const [interval, setBucketSize] = useState<AiUsageInterval>('day');
  const [includeTeams, setIncludeTeams] = useState(true);
  const bucketing = useReportBucketing();

  const rollup = canRollup && includeTeams;
  const params: AiUsageReportParams = {
    from: new Date(Date.now() - rangeDays * 86_400_000).toISOString(),
    interval,
    tz: bucketing.tz,
    ...(bucketing.weekStart ? { weekStart: bucketing.weekStart } : {}),
    ...(rollup ? { includeDescendants: true } : {}),
  };

  const reportQ = useFetch(async (signal) => {
    if (!bucketing.ready) return null;
    const res = await api.getAiUsageReport(orgId, params, { signal });
    return res.data?.report ?? null;
  }, [orgId, rangeDays, interval, rollup, bucketing.ready, bucketing.tz, bucketing.weekStart]);
  const report: AiUsageReport | null = reportQ.data;

  const exportMutation = useMutation({
    fn: (p: AiUsageReportParams) => api.downloadAiUsageCsv(orgId, p),
    scopeKey: orgId,
    errorFallback: 'AI usage export failed',
    toast: { error: true },
    onSuccess: ({ blob, filename }) => triggerBlobDownload(blob, filename),
  });

  const noUsage = report !== null && report.totals.calls === 0 && report.totals.units === 0 && report.totals.outcomes === 0;

  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-base font-semibold text-fg">AI assistant usage</h3>
          <p className="text-xs text-fg-muted mt-0.5">
            AI calls by feature and caller type, and how often AI drafts were kept. Counted per team and caller type, never per person.
            {report ? ` Times are in ${report.tz}.` : ''}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => { void exportMutation.run(params); }}
          loading={exportMutation.pending}
          disabled={exportMutation.pending || !bucketing.ready}
        >
          <Download className="w-4 h-4" aria-hidden="true" /> Export CSV
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <FilterSelect aria-label="AI usage range" value={rangeDays} onChange={(e) => setRangeDays(Number(e.target.value))} className="text-xs">
          {RANGES.map((d) => <option key={d} value={d}>{`Last ${d} days`}</option>)}
        </FilterSelect>
        <FilterSelect aria-label="AI usage interval" value={interval} onChange={(e) => setBucketSize(e.target.value as AiUsageInterval)} className="text-xs">
          <option value="day">By day</option>
          <option value="week">By week</option>
        </FilterSelect>
        {canRollup && (
          <FilterSelect aria-label="AI usage scope" value={includeTeams ? 'rollup' : 'org'} onChange={(e) => setIncludeTeams(e.target.value === 'rollup')} className="text-xs">
            <option value="rollup">Organization and teams</option>
            <option value="org">This organization only</option>
          </FilterSelect>
        )}
      </div>

      {reportQ.error ? (
        <ErrorAlert message={formatError(reportQ.error, 'Could not load AI usage')} />
      ) : !report ? (
        <div className="h-24 skeleton rounded" />
      ) : noUsage ? (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">No AI calls in the selected range.</p>
          {report.acceptanceSince === null && <InfoAlert message={ACCEPTANCE_STARTS} />}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="AI calls" value={fmtNum(report.totals.calls)} />
            <StatCard label="Units charged" value={fmtNum(report.totals.units)} />
            <StatCard label="Tokens (in / out)" value={`${fmtNum(report.totals.tokensIn)} / ${fmtNum(report.totals.tokensOut)}`} />
            <StatCard label="Draft acceptance" value={pct(report.totals.acceptanceRate)} />
          </div>

          {report.acceptanceSince === null ? (
            <InfoAlert message={ACCEPTANCE_STARTS} />
          ) : new Date(report.acceptanceSince) > new Date(report.from) ? (
            <InfoAlert message={`Draft acceptance has been recorded since ${formatDate(report.acceptanceSince)}; earlier ${interval === 'day' ? 'days' : 'weeks'} show usage only.`} />
          ) : null}

          <SliceTable
            caption={interval === 'day' ? 'By day' : 'By week'}
            rows={report.buckets}
            rowKey={(b) => b.bucket}
            columns={[
              { label: interval === 'day' ? 'Day' : 'Week of', cell: (b) => <span className="font-mono text-xs">{b.bucket}</span> },
              { label: 'Calls', cell: (b) => fmtNum(b.calls), numeric: true },
              { label: 'Units', cell: (b) => fmtNum(b.units), numeric: true },
              { label: 'Drafts', cell: (b) => (b.outcomes ? fmtNum(b.outcomes) : '—'), numeric: true },
              { label: 'Accepted', cell: (b) => pct(b.acceptanceRate), numeric: true },
            ]}
          />

          <SliceTable
            caption="By feature"
            rows={report.byFeature}
            rowKey={(f) => f.feature}
            columns={[
              { label: 'Feature', cell: (f) => AI_FEATURE_LABEL[f.feature] ?? f.feature },
              { label: 'Calls', cell: (f) => fmtNum(f.calls), numeric: true },
              { label: 'Units', cell: (f) => fmtNum(f.units), numeric: true },
              { label: 'Accepted', cell: (f) => (f.outcomes ? fmtNum(f.accepted) : '—'), numeric: true },
              { label: 'Edited', cell: (f) => (f.outcomes ? fmtNum(f.editedAccepted) : '—'), numeric: true },
              { label: 'Discarded', cell: (f) => (f.outcomes ? fmtNum(f.discarded) : '—'), numeric: true },
              { label: 'Acceptance', cell: (f) => pct(f.acceptanceRate), numeric: true },
            ]}
          />

          <SliceTable
            caption="By caller type"
            rows={report.byCallerType}
            rowKey={(c) => c.callerType}
            columns={[
              { label: 'Caller', cell: (c) => CALLER_LABEL[c.callerType] ?? c.callerType },
              { label: 'Calls', cell: (c) => fmtNum(c.calls), numeric: true },
              { label: 'Units', cell: (c) => fmtNum(c.units), numeric: true },
              { label: 'Tokens out', cell: (c) => fmtNum(c.tokensOut), numeric: true },
            ]}
          />

          {report.byTeam && (
            <SliceTable
              caption="By team"
              rows={report.byTeam}
              rowKey={(t) => t.orgId}
              columns={[
                { label: 'Team', cell: (t) => (t.orgId === report.orgId ? `${t.name ?? 'This organization'} (organization)` : (t.name ?? <span className="font-mono text-xs">{t.orgId}</span>)) },
                { label: 'Calls', cell: (t) => fmtNum(t.calls), numeric: true },
                { label: 'Units', cell: (t) => fmtNum(t.units), numeric: true },
                { label: 'Tokens out', cell: (t) => fmtNum(t.tokensOut), numeric: true },
              ]}
            />
          )}
        </div>
      )}
    </Card>
  );
}
