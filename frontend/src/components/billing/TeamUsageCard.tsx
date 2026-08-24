import { useCallback, useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import api from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useFeatures } from '@/hooks/useFeatures';
import { fmtNum, formatBytes } from '@/lib/format';
import { formatError } from '@/lib/constants';
import { FEATURE_METADATA } from '@/lib/feature-flags';
import type { TeamUsageRow } from '@/lib/api/domains/billing';

/** Quota dimensions shown per team, with their display formatters. */
const DIMENSIONS: { key: string; label: string; fmt: (n: number) => string }[] = [
  { key: 'pipelines', label: 'Pipelines', fmt: fmtNum },
  { key: 'apiCalls', label: 'API Calls', fmt: fmtNum },
  { key: 'aiCalls', label: 'AI Calls', fmt: fmtNum },
  { key: 'storageBytes', label: 'Storage', fmt: formatBytes },
  { key: 'plugins', label: 'Plugins', fmt: fmtNum },
];

const cell = (v: number | null | undefined, fmt: (n: number) => string) => (v == null ? '—' : fmt(v));

const TEAM_USAGE_COLUMNS: Column<TeamUsageRow>[] = [
  { id: 'team', header: 'Team', cellClassName: 'text-[var(--pb-text-muted)]', render: (t) => t.name ?? t.orgId },
  { id: 'seats', header: 'Seats', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (t) => cell(t.seats, fmtNum) },
  ...DIMENSIONS.map((d): Column<TeamUsageRow> => ({
    id: d.key,
    header: d.label,
    headerClassName: 'text-right',
    cellClassName: 'text-right tabular-nums text-[var(--pb-text-muted)]',
    render: (t) => cell(t.usage[d.key], d.fmt),
  })),
];

/**
 * Per-team usage breakdown (feature `team_usage_analytics`). Shows each team's
 * CURRENT-period usage across quota dimensions + seats — usage only, since
 * limits pool at the account root. Not entitled → an upsell; entitled but no
 * teams → a hint; entitled with teams → the table.
 */
export function TeamUsageCard() {
  const enabled = useFeatures().isEnabled('team_usage_analytics');
  const [teams, setTeams] = useState<TeamUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Distinguish a genuine "no teams" from a failed load — otherwise a fetch
  // error renders the empty hint and hides the failure.
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.getTeamUsage({ includeDescendants: true });
      setTeams(r?.data?.teams ?? []);
    } catch (e) {
      setError(formatError(e, 'Failed to load team usage.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    let active = true;
    (async () => {
      setError(null);
      try {
        const r = await api.getTeamUsage({ includeDescendants: true });
        if (active && r?.data) setTeams(r.data.teams);
      } catch (e) {
        if (active) setError(formatError(e, 'Failed to load team usage.'));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [enabled]);

  if (!enabled) {
    const meta = FEATURE_METADATA.team_usage_analytics;
    return (
      <Card>
        <h3 className="text-sm font-semibold text-[var(--pb-text)]">{meta.label}</h3>
        <p className="text-sm text-[var(--pb-text-muted)] mt-1">{meta.description}. Included with Enterprise, or add it for $30/mo.</p>
      </Card>
    );
  }

  if (loading) return null;

  if (error) {
    return (
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--pb-text)]">Team usage</h3>
            <p className="text-sm text-red-600 dark:text-red-400 mt-1" role="alert">{error}</p>
          </div>
          <button type="button" onClick={() => void reload()} className="action-link text-sm shrink-0">Retry</button>
        </div>
      </Card>
    );
  }

  // Entitled but a single-org account (no teams) — nothing to break down yet.
  if (teams.length <= 1) {
    return (
      <Card>
        <h3 className="text-sm font-semibold text-[var(--pb-text)]">Team usage</h3>
        <p className="text-sm text-[var(--pb-text-muted)] mt-1">Create teams under your organization to see per-team usage.</p>
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--pb-text)]">Team usage</h3>
        <span className="text-xs text-[var(--pb-text-muted)]">Current period · usage only (limits are account-wide)</span>
      </div>
      <DataTable
        data={teams}
        columns={TEAM_USAGE_COLUMNS}
        isLoading={false}
        animated={false}
        getRowKey={(t) => t.orgId}
        emptyState={{ icon: Users, title: 'No teams', description: 'No per-team usage to display.' }}
      />
    </Card>
  );
}
