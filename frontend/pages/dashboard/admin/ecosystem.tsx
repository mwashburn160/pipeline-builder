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

import { Store } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useSessionAssurance } from '@/hooks/useSessionAssurance';
import { useGroupedUrlTab } from '@/hooks/useGroupedUrlTab';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { EmptyState } from '@/components/ui/EmptyState';
import { GroupedTabs, type GroupedTabItem } from '@/components/ui/GroupedTabs';
import { EcosystemMfaPrompt } from '@/components/ecosystem/EcosystemMfaPrompt';
import { EcosystemManagersPanel } from '@/components/ecosystem/EcosystemManagersPanel';
import { PublishQueuePanel } from '@/components/ecosystem/PublishQueuePanel';
import { PublisherVerificationPanel } from '@/components/ecosystem/PublisherVerificationPanel';
import { AutoApprovalRulesPanel } from '@/components/ecosystem/AutoApprovalRulesPanel';
import { ListingStatePanel } from '@/components/ecosystem/ListingStatePanel';
import { ReservedNamesPanel } from '@/components/ecosystem/ReservedNamesPanel';
import { AdvisoriesPanel } from '@/components/ecosystem/AdvisoriesPanel';
import { ReviewModerationPanel } from '@/components/ecosystem/ReviewModerationPanel';
import { FleetVulnerabilityPanel } from '@/components/ecosystem/FleetVulnerabilityPanel';
import { KeptSetupImagesPanel } from '@/components/ecosystem/KeptSetupImagesPanel';
import { RetentionPanel } from '@/components/ecosystem/RetentionPanel';
import { canSeeEcosystemConsole } from '@/lib/ecosystem-access';
import { hasPermission } from '@/lib/auth-helpers';
import { ECOSYSTEM_TABS, type EcosystemSection, type EcosystemTab } from '@/lib/page-tabs/ecosystem';

type Permission = Parameters<typeof hasPermission>[1];

/**
 * Each panel with the permissions its reads need (ANY of them) — the same gates
 * the console routes apply (`requireSystemOrgPermission`), so a
 * `publishers:verify`-only manager doesn't see panels that would 403. A tab
 * shows when any of its panels does.
 */
const PANELS: Record<EcosystemSection | 'managers', { label: string; requires: readonly Permission[] }> = {
  queue: { label: 'Publish queue', requires: ['plugins:moderate', 'publishers:verify'] },
  publishers: { label: 'Publisher verification', requires: ['plugins:moderate', 'publishers:verify'] },
  rules: { label: 'Auto-approval rules', requires: ['plugins:moderate'] },
  listings: { label: 'Listing states', requires: ['plugins:moderate'] },
  reviews: { label: 'Review moderation', requires: ['plugins:moderate'] },
  reserved: { label: 'Reserved names', requires: ['plugins:moderate'] },
  advisories: { label: 'Advisories', requires: ['plugins:moderate'] },
  vulnerabilities: { label: 'Vulnerabilities', requires: ['plugins:moderate'] },
  'kept-images': { label: 'Kept setup images', requires: ['plugins:moderate'] },
  // Its reads need plugins:moderate, but it is shown to every console viewer:
  // the panel renders a locked state without the permission, so a
  // publishers:verify-only manager sees that it exists and what it needs.
  retention: { label: 'Retention', requires: ['plugins:moderate', 'publishers:verify'] },
  managers: { label: 'Managers', requires: ['plugins:moderate', 'publishers:verify'] },
};

/** Top-level tabs, in order (their panels are `ECOSYSTEM_TABS.groups`). */
const TAB_LABELS: Record<EcosystemTab, string> = {
  publishing: 'Publishing',
  listings: 'Listings',
  security: 'Security',
  storage: 'Storage',
  managers: 'Managers',
};
const TAB_PREFIX = 'ecosystem';

export default function EcosystemConsolePage() {
  const { isReady, user, isSuperAdmin, isReadOnly, can } = useAuthGuard();
  const aal = useSessionAssurance(user);
  // VISIBILITY uses the held permissions, not `can()`: the ecosystem
  // permissions are write-class, so `can()` is false during a read-only
  // impersonation — which should still SEE the console (writes stay disabled).
  const holds = (p: Permission) => !!user && hasPermission(user, p);
  const shows = (panel: EcosystemSection | 'managers') => isSuperAdmin || PANELS[panel].requires.some((p) => holds(p));
  const visibleSections = (t: EcosystemTab) => ECOSYSTEM_TABS.groups[t].filter(shows);
  const visibleTabs = (Object.keys(TAB_LABELS) as EcosystemTab[])
    .filter((t) => (t === 'managers' ? shows('managers') : visibleSections(t).length > 0));
  // In the URL, so a moderation console tab can be linked, bookmarked and
  // survive a refresh — the queue is a place people send each other to. A link
  // naming a tab the viewer can't see lands on the first one they can.
  const { tab, section, select } = useGroupedUrlTab(ECOSYSTEM_TABS, { tabs: visibleTabs, sections: visibleSections });

  if (!isReady || !user) return <LoadingPage />;

  // The held-permission reading the tabs use, handed to the panels for their
  // READ affordances (`can` is false for these during a read-only
  // impersonation, which may still GET).
  const allowed = canSeeEcosystemConsole(user, holds);
  const items: GroupedTabItem<EcosystemTab, EcosystemSection>[] = visibleTabs.map((t) => ({
    id: t,
    label: TAB_LABELS[t],
    name: TAB_LABELS[t],
    sections: visibleSections(t).map((id) => ({ id, label: PANELS[id].label })),
  }));
  const panel = section ?? tab;

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
        <GroupedTabs items={items} tab={tab} section={section} onSelect={select} idPrefix={TAB_PREFIX} ariaLabel="Ecosystem sections">
          {panel === 'queue' && <PublishQueuePanel can={can} holds={holds} />}
          {panel === 'publishers' && <PublisherVerificationPanel can={can} holds={holds} />}
          {panel === 'rules' && <AutoApprovalRulesPanel can={can} currentUserId={user.id} />}
          {panel === 'listings' && <ListingStatePanel can={can} />}
          {panel === 'reviews' && <ReviewModerationPanel can={can} />}
          {panel === 'reserved' && <ReservedNamesPanel can={can} />}
          {panel === 'advisories' && <AdvisoriesPanel can={can} />}
          {panel === 'vulnerabilities' && <FleetVulnerabilityPanel />}
          {panel === 'kept-images' && <KeptSetupImagesPanel can={can} />}
          {panel === 'retention' && <RetentionPanel holds={holds} can={can} readOnly={isReadOnly} />}
          {panel === 'managers' && <EcosystemManagersPanel isSuperAdmin={isSuperAdmin} canWrite={!isReadOnly} />}
        </GroupedTabs>
      )}
    </DashboardLayout>
  );
}
