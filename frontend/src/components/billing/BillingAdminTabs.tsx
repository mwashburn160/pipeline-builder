// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { TabBar } from '@/components/ui/TabBar';

/**
 * Segmented tabs linking the three platform billing-admin views — fleet billing
 * Overview, Discounts, and Promotions. They used to be three separate sidebar
 * items; now they're one "Billing Admin" entry with these tabs to switch between
 * them. Thin wrapper over the shared `TabBar` primitive (link/navigation mode),
 * mirroring the Builds queue/triage consolidation.
 */
const TABS = [
  { id: 'admin', label: 'Overview', href: '/dashboard/admin/billing' },
  { id: 'discounts', label: 'Discounts', href: '/dashboard/discounts' },
  { id: 'promotions', label: 'Promotions', href: '/dashboard/promotions' },
] as const;

export type BillingAdminTab = (typeof TABS)[number]['id'];

export function BillingAdminTabs({ active }: { active: BillingAdminTab }) {
  return <TabBar items={TABS} activeId={active} />;
}
