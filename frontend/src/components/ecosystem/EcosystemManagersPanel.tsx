// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Users } from 'lucide-react';
import { SystemOrgRoleRoster } from '@/components/admin/SystemOrgRoleRoster';
import { ECOSYSTEM_MANAGER_ROLE_NAME } from '@/lib/ecosystem-access';

interface Props {
  /** Only superadmins may assign or unassign the role; the
   *  backend refuses everyone else with RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN. */
  isSuperAdmin: boolean;
  /** False during a read-only impersonation — writes would 403. */
  canWrite: boolean;
}

/**
 * The system org's built-in **Ecosystem Manager** role roster.
 *
 * It stays HERE, on the Ecosystem console, rather than moving to Platform
 * staffing with the other four job Roles: the people who assign it are the
 * people running the moderation queue, and the queue is on this page. What it no
 * longer does is implement the roster — `SystemOrgRoleRoster` does, and this is
 * the configuration of it. Six near-identical panels was the alternative, and
 * the rules they share (read the Role by its seeded name, superadmin-only
 * assignment, candidates are active system-org members) are exactly the rules
 * that must not drift between them.
 */
export function EcosystemManagersPanel({ isSuperAdmin, canWrite }: Props) {
  return (
    <SystemOrgRoleRoster
      roleName={ECOSYSTEM_MANAGER_ROLE_NAME}
      title="Ecosystem Managers"
      icon={Users}
      description="System-org members who approve listings and versions, verify publishers and moderate reviews and submissions."
      emptyDescription="Until someone holds the role, superadmins receive every moderation notice."
      isSuperAdmin={isSuperAdmin}
      canWrite={canWrite}
    />
  );
}
