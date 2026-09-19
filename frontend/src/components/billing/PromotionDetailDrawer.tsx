// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import api from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { DescriptionList } from '@/components/ui/DescriptionList';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { SideDrawer } from '@/components/ui/SideDrawer';
import { useFetch } from '@/hooks/useFetch';
import { formatError } from '@/lib/constants';
import { formatCents } from '@/lib/format';
import type { Promotion } from '@/lib/api/domains/billing';

const EVENT_LABELS: Record<Promotion['trigger']['event'], string> = {
  subscription_created: 'On signup',
  plan_change: 'On plan change',
  manual: 'Manual only',
  referral: 'Referral (two-sided)',
};

/** A grant amount in the promotion's own unit (percent points, else cents). */
function amount(p: Promotion, value: number): string {
  return p.unit === 'percent' ? `${value}%` : formatCents(value);
}

/**
 * One promotion campaign, read fresh from `GET /billing/admin/promotions/:id`.
 * Opened from the list row or a `?id=` deep link.
 */
export function PromotionDetailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, loading, error, refetch } = useFetch(
    async (signal) => (await api.getPromotion(id, { signal })).data?.promotion ?? null,
    [id],
  );
  const p = data;
  const none = <span className="text-[var(--pb-text-muted)]">—</span>;
  const conditions = p?.trigger.conditions;

  return (
    <SideDrawer
      title={p?.name ?? 'Promotion'}
      subtitle={p && <Badge color={p.isActive ? 'green' : 'gray'}>{p.isActive ? 'Active' : 'Inactive'}</Badge>}
      onClose={onClose}
      ariaLabel="Promotion details"
    >
      {error ? (
        <RetryError message={formatError(error, 'Failed to load promotion')} onRetry={refetch} />
      ) : loading || !p ? (
        <LoadingSpinner label="Loading promotion" />
      ) : (
        <DescriptionList
          items={[
            { label: 'ID', value: <span className="font-mono text-xs break-all">{p.id}</span> },
            { label: 'Campaign', value: p.campaign || none },
            { label: 'Grant', value: `${amount(p, p.value)} ${p.kind === 'recurring' ? 'each period' : 'one-time'}` },
            ...(p.referrerValue != null ? [{ label: 'Referrer grant', value: amount(p, p.referrerValue) }] : []),
            { label: 'Trigger', value: EVENT_LABELS[p.trigger.event] ?? p.trigger.event },
            { label: 'Eligible tiers', value: conditions?.tiers?.length ? conditions.tiers.join(', ') : 'All' },
            { label: 'Intervals', value: conditions?.intervals?.length ? conditions.intervals.join(', ') : 'All' },
            { label: 'First subscription only', value: conditions?.firstSubscriptionOnly ? 'Yes' : 'No' },
            { label: 'Budget', value: `${formatCents(p.spentCents)} spent of ${formatCents(p.budgetCents)}` },
            { label: 'Grants', value: `${p.grantsCount}${p.maxGrants != null ? ` / ${p.maxGrants}` : ''}` },
            { label: 'Per-org cap', value: p.perOrgCapCents != null ? formatCents(p.perOrgCapCents) : none },
            { label: 'Window', value: p.startsAt || p.endsAt ? <>{p.startsAt ? <RelativeTime value={p.startsAt} /> : 'Now'} → {p.endsAt ? <RelativeTime value={p.endsAt} /> : 'open-ended'}</> : 'Always' },
            { label: 'Created', value: p.createdAt ? <RelativeTime value={p.createdAt} /> : none },
          ]}
        />
      )}
    </SideDrawer>
  );
}
