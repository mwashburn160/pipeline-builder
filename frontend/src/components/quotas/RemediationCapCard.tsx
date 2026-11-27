// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { RemediationOffNotice } from '@/components/plugin/RemediationOffNotice';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import type { PluginRemediationList } from '@/types/plugin-remediation';

/**
 * The org's daily remediation cap (`PLUGIN_REMEDIATION_MAX_PER_ORG_PER_DAY`):
 * nightly CVE fix builds spend no build credits, but at most this many start
 * per org per 24 hours. Best-effort: a failed read renders nothing, so the
 * quotas page never breaks on the plugin service. Needs `plugins:read` (the
 * remediations list is the source).
 */
export function RemediationCapCard() {
  const { can } = useAuthGuard();
  const canRead = can('plugins:read');
  const { data } = useFetch<PluginRemediationList | null>(
    async (signal) => {
      try {
        return (await api.listPluginRemediations({ limit: 1 }, { signal })).data ?? null;
      } catch {
        return null;
      }
    },
    [canRead],
    { enabled: canRead },
  );

  if (!canRead || !data) return null;
  const atCap = data.maxPerDay > 0 && data.usedToday >= data.maxPerDay;
  return (
    <Card data-testid="remediation-cap-card">
      <h3 className="text-sm font-semibold text-fg">Plugin security fixes</h3>
      <p className="mt-1 text-xs text-fg-muted">
        Remediation builds spend no build credits. Each organization can start a limited number per day.
      </p>
      {data.enabled ? (
        <p className="mt-3 text-sm text-fg">
          Remediations today: <span className="font-semibold tabular-nums">{data.usedToday} of {data.maxPerDay}</span>
          {atCap && <span className="ml-2 text-xs text-warning-strong">Cap reached; the rest wait for tomorrow.</span>}
        </p>
      ) : (
        <RemediationOffNotice className="mt-3" />
      )}
      <Link href="/dashboard/plugins?tab=security&section=remediations" className="action-link mt-3 inline-block text-xs">
        View remediations →
      </Link>
    </Card>
  );
}
