// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useBillingEnabledState } from '@/hooks/useBillingEnabled';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { LoadingPage } from '@/components/ui/Loading';
import { TabbedPage, usePageTabs } from '@/components/ui/TabbedPage';
import QuotasTab from '@/components/quotas/QuotasTab';
import BillingTab from '@/components/billing/BillingTab';
import { hasPermission } from '@/lib/auth-helpers';
import { BILLING_SECTION_KEY, USAGE_PATH } from '@/lib/tabbed-pages';

/** Query keys only the Billing tab reads. `checkout` is not here: a Checkout
 *  return lands on the billing tab and the tab clears it itself. */
const BILLING_ONLY_KEYS = [BILLING_SECTION_KEY, 'highlight'];

/**
 * Usage & billing: Quotas (`quotas:read`) and Billing (`billing:read`, shown
 * while the billing service is on). The page opens for a holder of either.
 */
export default function UsagePage() {
  const { accessDenied, user, isReady } = useAuthGuard();
  const billingEnabled = useBillingEnabledState();
  const { tabs, activeId, select } = usePageTabs(
    USAGE_PATH,
    { hasPermission: (p) => hasPermission(user, p), billingEnabled },
    BILLING_ONLY_KEYS,
  );

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  return (
    <TabbedPage title="Usage & billing" idPrefix="usage" ariaLabel="Usage and billing sections" tabs={tabs} activeId={activeId} onSelect={select}>
      {activeId === 'quotas' && <QuotasTab />}
      {activeId === 'billing' && <BillingTab />}
    </TabbedPage>
  );
}
