// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { LoadingPage } from '@/components/ui/Loading';
import { TabbedPage, usePageTabs } from '@/components/ui/TabbedPage';
import MembersTab from '@/components/members/MembersTab';
import RolesTab from '@/components/roles/RolesTab';
import InvitationsTab from '@/components/invitations/InvitationsTab';
import { hasPermission } from '@/lib/auth-helpers';
import { MEMBERS_PATH } from '@/lib/tabbed-pages';

/** `?email=` prefills the invitation composer; it means nothing on another tab. */
const INVITATIONS_ONLY_KEYS = ['email'];

/**
 * Members: the roster, teams, Roles and invitations. Each tab keeps its old
 * page's permission (`members:manage` for the roster and teams, `roles:manage`,
 * `invitations:manage`); the page opens for a holder of any of them.
 */
export default function MembersPage() {
  const { accessDenied, user, isReady } = useAuthGuard();
  const { tabs, activeId, select } = usePageTabs(MEMBERS_PATH, { hasPermission: (p) => hasPermission(user, p) }, INVITATIONS_ONLY_KEYS);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  return (
    <TabbedPage title="Members" idPrefix="members" ariaLabel="Member sections" tabs={tabs} activeId={activeId} onSelect={select}>
      {activeId === 'members' && <MembersTab view="members" />}
      {activeId === 'teams' && <MembersTab view="teams" />}
      {activeId === 'roles' && <RolesTab />}
      {activeId === 'invitations' && <InvitationsTab />}
    </TabbedPage>
  );
}
