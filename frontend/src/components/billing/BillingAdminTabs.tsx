// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { TabBar } from '@/components/ui/TabBar';

/**
 * Segmented tabs linking the platform billing-admin views — fleet billing
 * Overview, Campaigns, Discounts, Promotions and Offers — under one "Billing
 * admin" sidebar entry. Thin wrapper over the shared `TabBar` primitive
 * (link/navigation mode), mirroring the Builds queue/triage consolidation.
 *
 * Offers is a TAB rather than a page of its own because it is the same
 * audience, the same gate and the same question — what did we grant, to whom,
 * and why — for an automated granter instead of a hand-run campaign
 * (docs/plans/sales-agent.md F8).
 */
const TABS = [
  { id: 'admin', label: 'Overview', href: '/dashboard/admin/billing' },
  { id: 'campaigns', label: 'Campaigns', href: '/dashboard/campaigns' },
  { id: 'discounts', label: 'Discounts', href: '/dashboard/discounts' },
  { id: 'promotions', label: 'Promotions', href: '/dashboard/promotions' },
  { id: 'offers', label: 'Offers', href: '/dashboard/admin/offers' },
] as const;

export type BillingAdminTab = (typeof TABS)[number]['id'];

export function BillingAdminTabs({ active }: { active: BillingAdminTab }) {
  return <TabBar items={TABS} activeId={active} />;
}
