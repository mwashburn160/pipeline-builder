// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import api from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { EntityDetailDrawer } from '@/components/ui/EntityDetailDrawer';
import { RelativeTime } from '@/components/ui/RelativeTime';
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
  const none = <span className="text-fg-muted">—</span>;

  return (
    <EntityDetailDrawer
      fetch={async (signal) => (await api.getPromotion(id, { signal })).data?.promotion ?? null}
      deps={[id]}
      ariaLabel="Promotion details"
      fallbackTitle="Promotion"
      title={(p) => p.name}
      subtitle={(p) => <Badge color={p.isActive ? 'green' : 'gray'}>{p.isActive ? 'Active' : 'Inactive'}</Badge>}
      errorMessage="Failed to load promotion"
      loadingLabel="Loading promotion"
      onClose={onClose}
      items={(p) => {
        const conditions = p.trigger.conditions;
        return [
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
        ];
      }}
    />
  );
}
