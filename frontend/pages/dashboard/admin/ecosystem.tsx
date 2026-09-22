// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin-ecosystem governance console.
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

/**
 * Each tab with the permissions its reads need (ANY of them) — the same gates
 * the console routes apply (`requireEcosystemPermission`), so a
 * `publishers:verify`-only manager doesn't see tabs that would 403.
 */
const TABS = [
  { id: 'queue', label: 'Publish queue', requires: ['plugins:moderate', 'publishers:verify'] },
  { id: 'publishers', label: 'Publisher verification', requires: ['plugins:moderate', 'publishers:verify'] },
  { id: 'listings', label: 'Listings', requires: ['plugins:moderate'] },
  { id: 'advisories', label: 'Advisories', requires: ['plugins:moderate'] },
  { id: 'reviews', label: 'Review moderation', requires: ['plugins:moderate'] },
  { id: 'rules', label: 'Auto-approval rules', requires: ['plugins:moderate'] },
  { id: 'reserved', label: 'Reserved names', requires: ['plugins:moderate'] },
  { id: 'managers', label: 'Ecosystem Managers', requires: ['plugins:moderate', 'publishers:verify'] },
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
  // Same rule for the tabs: HELD permissions, so a read-only session still sees
  // what it may read.
  const visibleTabs = TABS.filter((t) => isSuperAdmin || t.requires.some((p) => hasPermission(user, p)));
  const activeTab: TabId = visibleTabs.some((t) => t.id === tab) ? tab : (visibleTabs[0]?.id ?? 'queue');

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
            items={visibleTabs.map(({ id, label }) => ({ id, label }))}
            activeId={activeTab}
            onSelect={(id) => setTab(id as TabId)}
            idPrefix={TAB_PREFIX}
            ariaLabel="Ecosystem sections"
            className="mb-4"
          />
          <div {...tabPanelProps(TAB_PREFIX, activeTab)}>
            {activeTab === 'queue' && <PublishQueuePanel can={can} />}
            {activeTab === 'publishers' && <PublisherVerificationPanel can={can} />}
            {activeTab === 'listings' && <ListingStatePanel can={can} />}
            {activeTab === 'advisories' && <AdvisoriesPanel can={can} />}
            {activeTab === 'reviews' && <ReviewModerationPanel can={can} />}
            {activeTab === 'rules' && <AutoApprovalRulesPanel can={can} currentUserId={user.id} />}
            {activeTab === 'reserved' && <ReservedNamesPanel can={can} />}
            {activeTab === 'managers' && <EcosystemManagersPanel isSuperAdmin={isSuperAdmin} canWrite={!isReadOnly} />}
          </div>
        </>
      )}
    </DashboardLayout>
  );
}
