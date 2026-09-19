import { Users } from 'lucide-react';
import api from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FeatureLock } from '@/components/ui/FeatureLock';
import { RetryError } from '@/components/ui/RetryError';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { useFetch } from '@/hooks/useFetch';
import { fmtNum, formatBytes } from '@/lib/format';
import { formatError } from '@/lib/constants';
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
  // The gate carries the superadmin bypass and the "not on your plan" copy; the
  // route itself is `requireFeature('team_usage_analytics')`.
  const gate = useFeatureGate('team_usage_analytics');
  const entitled = gate.isLoaded && gate.entitled;
  const { data, loading, error, refetch } = useFetch(
    async (signal) => (entitled ? (await api.getTeamUsage({ includeDescendants: true }, { signal })).data?.teams ?? [] : null),
    [entitled],
  );
  const teams = data ?? [];

  if (!gate.isLoaded) return null;

  if (!gate.entitled) {
    return (
      <Card>
        <h3 className="text-sm font-semibold text-[var(--pb-text)]">Team usage</h3>
        <FeatureLock flag="team_usage_analytics" className="mt-2" />
      </Card>
    );
  }

  if (loading) return null;

  // Distinguish a genuine "no teams" from a failed load — otherwise a fetch
  // error renders the empty hint and hides the failure.
  if (error) {
    return (
      <Card>
        <h3 className="text-sm font-semibold text-[var(--pb-text)] mb-2">Team usage</h3>
        <RetryError message={formatError(error, 'Failed to load team usage.')} onRetry={refetch} />
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
