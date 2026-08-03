import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { useFeatures } from '@/hooks/useFeatures';
import { fmtNum, formatBytes } from '@/lib/format';
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

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    let active = true;
    (async () => {
      const r = await api.getTeamUsage({ includeDescendants: true }).catch(() => null);
      if (!active) return;
      if (r?.data) setTeams(r.data.teams);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [enabled]);

  if (!enabled) {
    const meta = FEATURE_METADATA.team_usage_analytics;
    return (
      <Card>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{meta.label}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{meta.description}. Included with Enterprise, or add it for $30/mo.</p>
      </Card>
    );
  }

  if (loading) return null;

  // Entitled but a single-org account (no teams) — nothing to break down yet.
  if (teams.length <= 1) {
    return (
      <Card>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Team usage</h3>
        <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">Create teams under your organization to see per-team usage.</p>
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Team usage</h3>
        <span className="text-xs text-gray-400 dark:text-gray-500">Current period · usage only (limits are account-wide)</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-400 dark:text-gray-500 text-left">
            <th className="py-1.5 pr-4 font-medium">Team</th>
            <th className="py-1.5 pr-4 font-medium text-right">Seats</th>
            {DIMENSIONS.map((d) => <th key={d.key} className="py-1.5 pr-4 font-medium text-right">{d.label}</th>)}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {teams.map((t) => (
            <tr key={t.orgId} className="border-t border-gray-100 dark:border-gray-800">
              <td className="py-1.5 pr-4 text-gray-600 dark:text-gray-300">{t.name ?? t.orgId}</td>
              <td className="py-1.5 pr-4 text-right">{cell(t.seats, fmtNum)}</td>
              {DIMENSIONS.map((d) => <td key={d.key} className="py-1.5 pr-4 text-right text-gray-600 dark:text-gray-300">{cell(t.usage[d.key], d.fmt)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
