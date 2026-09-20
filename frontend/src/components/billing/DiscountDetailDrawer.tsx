// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import api from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { EntityDetailDrawer } from '@/components/ui/EntityDetailDrawer';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { formatDiscount } from '@/components/discounts/formatDiscount';

/**
 * One discount, read fresh from `GET /billing/admin/discounts/:id` (never a
 * token — the record only). Opened from the list row or a `?id=` deep link, so
 * it fetches by id rather than trusting a row that may be on another page.
 */
export function DiscountDetailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const none = <span className="text-fg-muted">—</span>;

  return (
    <EntityDetailDrawer
      fetch={async (signal) => (await api.getDiscount(id, { signal })).data?.discount ?? null}
      deps={[id]}
      ariaLabel="Discount details"
      fallbackTitle="Discount"
      title={(d) => formatDiscount(d)}
      subtitle={(d) => <Badge color={d.isActive ? 'green' : 'gray'}>{d.isActive ? 'Active' : 'Inactive'}</Badge>}
      errorMessage="Failed to load discount"
      loadingLabel="Loading discount"
      onClose={onClose}
      items={(d) => [
        { label: 'ID', value: <span className="font-mono text-xs break-all">{d.id}</span> },
        { label: 'Amount', value: formatDiscount(d) },
        { label: 'Campaign', value: d.campaign || none },
        { label: 'Public alias', value: d.alias ? <span className="font-mono text-xs">{d.alias}</span> : none },
        { label: 'Target org', value: d.targetOrgId ? <span className="font-mono text-xs">{d.targetOrgId}</span> : 'Any' },
        { label: 'Redemptions', value: `${d.timesRedeemed}${d.maxRedemptions != null ? ` / ${d.maxRedemptions}` : ' (no cap)'}` },
        { label: 'Redeem by', value: d.redeemBy ? <RelativeTime value={d.redeemBy} /> : 'No expiry' },
        { label: 'Tiers', value: d.appliesToTiers?.length ? d.appliesToTiers.join(', ') : 'All' },
        { label: 'Created', value: d.createdAt ? <RelativeTime value={d.createdAt} /> : none },
        { label: 'Updated', value: d.updatedAt ? <RelativeTime value={d.updatedAt} /> : none },
      ]}
    />
  );
}
