// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Download } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import { formatError } from '@/lib/constants';
import { triggerBlobDownload } from '@/lib/download';
import { fmtNum } from '@/lib/format';
import { QUOTA_TYPE_LABEL } from '@/lib/quota-pressure';
import api from '@/lib/api';
import type { QuotaType, QuotaUsageGroup, QuotaUsageGroupBy, QuotaUsageParams } from '@/types';

/** The quota types whose usage is attributed (everything that is incremented). */
const BREAKDOWN_TYPES: QuotaType[] = ['apiCalls', 'automationCalls', 'aiCalls', 'pipelines', 'plugins', 'listings', 'dashboards', 'alertRules', 'alertDestinations', 'idpConfigs'];

const GROUP_LABEL: Record<QuotaUsageGroupBy, string> = {
  principal: 'Who (user / service account)',
  route: 'Route',
  pipeline: 'Pipeline',
  day: 'Day',
  feature: 'Feature',
  model: 'Model',
};

/** Groupings only AI calls carry — offered for `aiCalls` alone, where they mean something. */
const AI_ONLY_GROUPS: ReadonlySet<QuotaUsageGroupBy> = new Set<QuotaUsageGroupBy>(['feature', 'model']);

const FEATURE_LABEL: Record<string, string> = {
  ask: 'Ask',
  agent: 'Ask agent',
  'pipeline-generate': 'Pipeline generation',
  'plugin-generate': 'Plugin generation',
  'report-summary': 'Report summary',
};

/** Human name for an AI feature key; `agent-tool:<name>` is one of the agent's tools. */
function featureLabel(feature: string): string {
  if (feature.startsWith('agent-tool:')) return `Ask agent tool: ${feature.slice('agent-tool:'.length)}`;
  return FEATURE_LABEL[feature] ?? feature;
}

/** True for a row served on the org's or the caller's own key — recorded, not charged. */
const ownKey = (g: QuotaUsageGroup) => !!g.keySource && g.keySource !== 'platform';

const PRINCIPAL_LABEL: Record<string, string> = {
  user: 'User',
  service_account: 'Service account',
  service: 'Internal service',
};

/** Range presets, in days back from now; `0` = the current usage period. */
const RANGES = [0, 7, 30, 90] as const;

/** ISO `from` for a range preset (`undefined` lets the server use the current period). */
function rangeFrom(days: number): string | undefined {
  return days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;
}

/**
 * "What used this quota" — the usage ledger for one org, grouped by principal,
 * route, pipeline or day (and, for AI calls, by feature or model), over a time
 * range, with a CSV export of the same rows. AI calls also show tokens in/out,
 * and a call served on an own key is labelled — it is recorded at 0, not charged.
 *
 * Scope follows pooling: a pool ROOT (or a flat org) sees its whole account,
 * the same units its pooled counter holds; a team sees only its own usage.
 * Denials are shown separately — a refused request never moved the counter, so
 * this is the only place it is visible.
 */
export function QuotaUsageBreakdown({ orgId, isTeam, periodDays }: {
  orgId: string;
  /** The org is a team: the breakdown covers its own usage, not the account's. */
  isTeam: boolean;
  periodDays?: number;
}) {
  const toast = useToast();
  const [type, setType] = useState<QuotaType>('apiCalls');
  const [groupBy, setGroupBy] = useState<QuotaUsageGroupBy>('principal');
  const [rangeDays, setRangeDays] = useState<number>(0);
  const [exporting, setExporting] = useState(false);

  const isAI = type === 'aiCalls';
  // Feature / model groupings exist only for AI calls; switching to another quota
  // falls back to "who", rather than sending a grouping the server would refuse.
  const effectiveGroupBy: QuotaUsageGroupBy = !isAI && AI_ONLY_GROUPS.has(groupBy) ? 'principal' : groupBy;
  const groupOptions = (Object.keys(GROUP_LABEL) as QuotaUsageGroupBy[]).filter((g) => isAI || !AI_ONLY_GROUPS.has(g));

  const params: QuotaUsageParams = { type, groupBy: effectiveGroupBy, from: rangeFrom(rangeDays) };
  const usageQ = useFetch(async (signal) => {
    const res = await api.getQuotaUsage(orgId, params, { signal });
    return res.data ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- params is derived from these
  }, [orgId, type, effectiveGroupBy, rangeDays]);
  const groups: QuotaUsageGroup[] = usageQ.data?.groups ?? [];
  const totalNet = groups.reduce((sum, g) => sum + g.net, 0);

  async function exportCsv() {
    setExporting(true);
    try {
      const { blob, filename } = await api.downloadQuotaUsageCsv(orgId, params);
      triggerBlobDownload(blob, filename);
    } catch (err) {
      toast.error(formatError(err, 'Usage export failed'));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-base font-semibold text-fg">What used this</h3>
          <p className="text-xs text-fg-muted mt-0.5">
            {isTeam
              ? 'This team’s own usage. The limit is shared with the whole organization.'
              : 'Usage across your whole organization, including every team.'}
            {usageQ.data ? ` History is kept for ${usageQ.data.retentionDays} days.` : ''}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={exportCsv} loading={exporting} disabled={exporting}>
          <Download className="w-4 h-4" aria-hidden="true" /> Export CSV
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <FilterSelect aria-label="Quota" value={type} onChange={(e) => setType(e.target.value as QuotaType)} className="text-xs">
          {BREAKDOWN_TYPES.map((t) => <option key={t} value={t}>{QUOTA_TYPE_LABEL[t]}</option>)}
        </FilterSelect>
        <FilterSelect aria-label="Group by" value={effectiveGroupBy} onChange={(e) => setGroupBy(e.target.value as QuotaUsageGroupBy)} className="text-xs">
          {groupOptions.map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
        </FilterSelect>
        <FilterSelect aria-label="Time range" value={rangeDays} onChange={(e) => setRangeDays(Number(e.target.value))} className="text-xs">
          {RANGES.map((d) => (
            <option key={d} value={d}>{d === 0 ? (periodDays ? `Current ${periodDays}-day period` : 'Current period') : `Last ${d} days`}</option>
          ))}
        </FilterSelect>
      </div>

      {usageQ.error ? (
        <ErrorAlert message={formatError(usageQ.error, 'Could not load usage')} />
      ) : usageQ.loading && !usageQ.data ? (
        <div className="h-24 skeleton rounded" />
      ) : groups.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing used this quota in the selected range.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                <th className="py-1.5 pr-3 font-semibold">{GROUP_LABEL[effectiveGroupBy]}</th>
                <th className="py-1.5 px-3 font-semibold text-right">Used</th>
                <th className="py-1.5 px-3 font-semibold text-right">Refused</th>
                <th className="py-1.5 px-3 font-semibold text-right" title="Served past the limit by concurrent requests; not counted">Over limit</th>
                {isAI && <th className="py-1.5 px-3 font-semibold text-right">Tokens in</th>}
                {isAI && <th className="py-1.5 px-3 font-semibold text-right">Tokens out</th>}
                <th className="py-1.5 pl-3 font-semibold text-right">Share</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={`${g.principalType ?? ''}:${g.key ?? '-'}:${g.keySource ?? ''}`} className="border-t border-default">
                  <td className="py-1.5 pr-3">
                    {effectiveGroupBy === 'feature' && g.key
                      ? <span className="text-sm">{featureLabel(g.key)}</span>
                      : <span className={g.key ? 'font-mono text-xs break-all' : 'text-fg-muted italic'}>{g.key ?? 'Unattributed'}</span>}
                    {g.principalType && (
                      <span className="ml-2 text-xs text-fg-subtle">
                        {PRINCIPAL_LABEL[g.principalType] ?? g.principalType}
                        {g.keyCount ? ` · ${g.keyCount} key${g.keyCount === 1 ? '' : 's'}` : ''}
                      </span>
                    )}
                    {/* An own-key call is in the ledger for its tokens, at amount 0. */}
                    {ownKey(g) && (
                      <span className="ml-2 text-xs text-fg-subtle" title="Served on your organization's or the caller's own provider key">
                        own key, not charged
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{fmtNum(g.net)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums text-fg-muted">{g.denied ? fmtNum(g.denied) : '—'}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums text-fg-muted">{g.overshoot ? fmtNum(g.overshoot) : '—'}</td>
                  {isAI && <td className="py-1.5 px-3 text-right tabular-nums text-fg-muted">{g.tokensIn ? fmtNum(g.tokensIn) : '—'}</td>}
                  {isAI && <td className="py-1.5 px-3 text-right tabular-nums text-fg-muted">{g.tokensOut ? fmtNum(g.tokensOut) : '—'}</td>}
                  <td className="py-1.5 pl-3 text-right tabular-nums text-fg-muted">
                    {totalNet > 0 ? `${Math.round((g.net / totalNet) * 100)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
