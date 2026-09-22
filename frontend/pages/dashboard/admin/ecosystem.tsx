// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin-ecosystem governance console (plan §3.0, §5a.1).
 *
 * Exists ONLY in the system org, for its Ecosystem Managers (`plugins:moderate`
 * / `publishers:verify`) and superadmins. The nav hides the entry everywhere
 * else (`NavItem.systemOrgOnly`), but hiding a link is not a gate, so the page
 * applies the same rule itself (`canSeeEcosystemConsole`) and renders a plain
 * "not available" state to anyone else. It's declared OPEN in page-access (its
 * nav item carries no single-permission gate) because the refusal here is not an
 * RBAC denial a tenant could fix by being granted something.
 *
 * Every ecosystem-management route requires an MFA-grade session (aal2), so a
 * single-factor session sees an enrol / sign-in-again prompt instead.
 */

import { useState } from 'react';
import { Store } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useSessionAssurance } from '@/hooks/useSessionAssurance';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { EmptyState } from '@/components/ui/EmptyState';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { EcosystemMfaPrompt } from '@/components/ecosystem/EcosystemMfaPrompt';
import { EcosystemManagersPanel } from '@/components/ecosystem/EcosystemManagersPanel';
import { PublishQueuePanel } from '@/components/ecosystem/PublishQueuePanel';
import { PublisherVerificationPanel } from '@/components/ecosystem/PublisherVerificationPanel';
import { AutoApprovalRulesPanel } from '@/components/ecosystem/AutoApprovalRulesPanel';
import { ListingStatePanel } from '@/components/ecosystem/ListingStatePanel';
import { ReservedNamesPanel } from '@/components/ecosystem/ReservedNamesPanel';
import { AdvisoriesPanel } from '@/components/ecosystem/AdvisoriesPanel';
import { ReviewModerationPanel } from '@/components/ecosystem/ReviewModerationPanel';
import { canSeeEcosystemConsole } from '@/lib/ecosystem-access';
import { hasPermission } from '@/lib/auth-helpers';

const TABS = [
  { id: 'queue', label: 'Publish queue' },
  { id: 'publishers', label: 'Publisher verification' },
  { id: 'listings', label: 'Listings' },
  { id: 'advisories', label: 'Advisories' },
  { id: 'reviews', label: 'Review moderation' },
  { id: 'rules', label: 'Auto-approval rules' },
  { id: 'reserved', label: 'Reserved names' },
  { id: 'managers', label: 'Ecosystem Managers' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const TAB_PREFIX = 'ecosystem';

export default function EcosystemConsolePage() {
  const { isReady, user, isSuperAdmin, isReadOnly, can } = useAuthGuard();
  const aal = useSessionAssurance(user);
  const [tab, setTab] = useState<TabId>('queue');

  if (!isReady || !user) return <LoadingPage />;

  // VISIBILITY uses the held permissions, not `can()`: the ecosystem
  // permissions are write-class, so `can()` is false during a read-only
  // impersonation — which should still SEE the console (writes stay disabled).
  const allowed = canSeeEcosystemConsole(user, (p) => hasPermission(user, p));

  return (
    <DashboardLayout title="Ecosystem" subtitle="Plugin ecosystem governance for the system organization">
      {!allowed ? (
        <EmptyState
          icon={Store}
          title="Not available"
          description="The Ecosystem console is only available in the system organization, to Ecosystem Managers and superadmins."
        />
      ) : aal === null ? (
        <LoadingPage />
      ) : aal < 2 ? (
        <EcosystemMfaPrompt user={user} />
      ) : (
        <>
          <TabBar
            items={TABS}
            activeId={tab}
            onSelect={(id) => setTab(id as TabId)}
            idPrefix={TAB_PREFIX}
            ariaLabel="Ecosystem sections"
            className="mb-4"
          />
          <div {...tabPanelProps(TAB_PREFIX, tab)}>
            {tab === 'queue' && <PublishQueuePanel can={can} />}
            {tab === 'publishers' && <PublisherVerificationPanel can={can} />}
            {tab === 'listings' && <ListingStatePanel can={can} />}
            {tab === 'advisories' && <AdvisoriesPanel can={can} />}
            {tab === 'reviews' && <ReviewModerationPanel can={can} />}
            {tab === 'rules' && <AutoApprovalRulesPanel can={can} currentUserId={user.id} />}
            {tab === 'reserved' && <ReservedNamesPanel can={can} />}
            {tab === 'managers' && <EcosystemManagersPanel isSuperAdmin={isSuperAdmin} canWrite={!isReadOnly} />}
          </div>
        </>
      )}
    </DashboardLayout>
  );
}
