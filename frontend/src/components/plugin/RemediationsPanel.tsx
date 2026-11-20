// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { SegmentedFilter } from '@/components/ui/SegmentedFilter';
import { Skeleton } from '@/components/ui/Skeleton';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { REMEDIATION_STAGE_FILTERS } from '@/lib/plugin-remediation';
import type { PluginRemediationDto } from '@/types/plugin-remediation';
import { RemediationCard, RemediationStageBadge } from './RemediationCard';
import { RemediationOffNotice } from './RemediationOffNotice';

const PAGE_SIZE = 50;

/**
 * Plugins → Remediations: every remediation in the org, newest first,
 * filterable by stage, with the plugin and its affected pipelines one click
 * away. A row expands into its full card (Approve / Reject live there).
 */
export function RemediationsPanel({ canWrite, isSystemOrg = false, focusId, onOpenPlugin }: {
  canWrite: boolean;
  isSystemOrg?: boolean;
  /** `?remediation=<id>`: that row starts expanded. */
  focusId?: string;
  /** Open a plugin version's detail by id. */
  onOpenPlugin?: (pluginId: string) => void;
}) {
  const [filter, setFilter] = useState('all');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<string | null>(focusId ?? null);
  useEffect(() => { if (focusId) setExpanded(focusId); }, [focusId]);

  const stages = REMEDIATION_STAGE_FILTERS.find((f) => f.key === filter)?.stages ?? [];
  const q = useFetch(async (signal) => {
    const res = await api.listPluginRemediations({ stage: stages.join(',') || undefined, limit: PAGE_SIZE, cursor }, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load remediations');
    return res.data;
  }, [filter, cursor]);

  const data = q.data;
  const rows: PluginRemediationDto[] = data?.remediations ?? [];

  return (
    <div className="space-y-3" data-testid="remediations-panel">
      {data && !data.enabled && <RemediationOffNotice />}
      {data && (
        <p className="text-xs text-fg-muted" data-testid="remediations-usage">
          {data.usedToday} of {data.maxPerDay} remediations started in the last 24 hours
          {data.optedOutPipelines != null && (
            <>
              {' · '}
              <Link href="/dashboard/pipelines?remediationUpgrades=off" className="action-link" data-testid="remediations-opted-out">
                {data.optedOutPipelines} pipeline{data.optedOutPipelines === 1 ? '' : 's'} opted out of plugin security fixes
              </Link>
            </>
          )}
        </p>
      )}
      <SegmentedFilter
        ariaLabel="Remediation stage"
        options={REMEDIATION_STAGE_FILTERS.map((f) => ({ value: f.key, label: f.label }))}
        value={filter}
        onChange={(v) => { setFilter(v); setCursor(undefined); }}
      />
      {q.loading && !data ? (
        <Skeleton className="h-24 w-full" />
      ) : q.error ? (
        <RetryError message={formatError(q.error, 'Failed to load remediations')} onRetry={q.refetch} />
      ) : rows.length === 0 ? (
        <EmptyState title="No remediations" description="Flagged plugin versions your organization may change show up here after the nightly rescan." />
      ) : (
        <ul className="divide-y divide-default rounded-md border border-default" aria-label="Remediations">
          {rows.map((r) => {
            const open = expanded === r.id;
            const counts = r.rollout?.counts;
            return (
              <li key={r.id} className={`p-2 text-sm ${focusId === r.id ? 'bg-info-bg' : ''}`} data-testid={`remediation-row-${r.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 font-medium text-fg"
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : r.id)}
                  >
                    {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                    {r.pluginName} {r.fromVersion}{r.toVersion ? ` → ${r.toVersion}` : ''}
                  </button>
                  <RemediationStageBadge stage={r.stage} />
                  <span className="text-xs text-fg-muted">
                    {r.cleared.length} cleared · {r.remaining.length} left
                    {counts && ` · ${counts.moved}/${counts.eligible} pipelines moved`}
                    {counts && counts.skippedOptOut > 0 && ` · ${counts.skippedOptOut} opted out`}
                  </span>
                  <span className="text-xs text-fg-muted"><RelativeTime value={r.updatedAt} /></span>
                  {onOpenPlugin && (
                    <button type="button" className="action-link text-xs" onClick={() => onOpenPlugin(r.pluginId)}>Open plugin</button>
                  )}
                </div>
                {open && (
                  <div className="mt-2">
                    <RemediationCard remediation={r} canWrite={canWrite} isSystemOrg={isSystemOrg} onChanged={() => q.refetch()} onOpenPlugin={onOpenPlugin} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex gap-2">
        {cursor && <Button variant="outline" size="xs" onClick={() => setCursor(undefined)}>First page</Button>}
        {data?.nextCursor && <Button variant="outline" size="xs" onClick={() => setCursor(data.nextCursor ?? undefined)}>Next page</Button>}
      </div>
    </div>
  );
}
