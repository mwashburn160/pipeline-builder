// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Receipt } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import api from '@/lib/api';
import type { MarketplaceEntitlements, MarketplaceEntitlement } from '@/lib/api/domains/billing';
import { formatDate } from '@/lib/format';

const ENTITLEMENT_COLUMNS: Column<MarketplaceEntitlement>[] = [
  { id: 'plan', header: 'Plan', cellClassName: 'font-mono text-fg', render: (e) => e.planId },
  { id: 'dimension', header: 'Dimension', cellClassName: 'text-fg-muted', render: (e) => e.dimension },
  {
    id: 'status',
    header: 'Status',
    render: (e) => (e.isEntitled
      ? <span className="text-success font-medium">Entitled</span>
      : <span className="text-fg-subtle">Not entitled</span>),
  },
  { id: 'expires', header: 'Expires', cellClassName: 'text-fg-muted', render: (e) => formatDate(e.expirationDate) },
];

/**
 * Read-only panel listing the org's current AWS Marketplace entitlements. Only
 * meaningful for Marketplace-billed accounts — self-fetches and fails soft: a
 * 400 (provider isn't marketplace) or 404 (no marketplace subscription) simply
 * renders nothing, so non-Marketplace deployments never see it.
 */
export function MarketplaceEntitlementsPanel() {
  const [data, setData] = useState<MarketplaceEntitlements | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getMarketplaceEntitlements()
      .then((res) => { if (!cancelled && res.success && res.data) setData(res.data); })
      .catch(() => { /* fail-soft: not a marketplace account, or none found */ });
    return () => { cancelled = true; };
  }, []);

  if (!data || data.entitlements.length === 0) return null;

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h3 className="h3">AWS Marketplace Entitlements</h3>
        <span className="text-xs text-fg-subtle">Managed in AWS</span>
      </div>
      <p className="mt-1 text-xs text-fg-muted">
        Current plan <code className="font-mono">{data.currentPlanId}</code> · customer{' '}
        <code className="font-mono break-all">{data.customerIdentifier}</code>
      </p>
      <div className="mt-4 overflow-x-auto">
        <DataTable
          data={data.entitlements}
          columns={ENTITLEMENT_COLUMNS}
          isLoading={false}
          animated={false}
          getRowKey={(e, i) => `${e.planId}-${e.dimension}-${i}`}
          emptyState={{ icon: Receipt, title: 'No entitlements', description: 'No AWS Marketplace entitlements found.' }}
        />
      </div>
    </Card>
  );
}
