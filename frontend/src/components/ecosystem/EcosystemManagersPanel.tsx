// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { BadgeCheck, Users } from 'lucide-react';
import { SystemOrgRoleRoster } from '@/components/admin/SystemOrgRoleRoster';
import { ECOSYSTEM_MANAGER_ROLE_NAME, PUBLISHER_VERIFIER_ROLE_NAME } from '@/lib/ecosystem-access';

interface Props {
  /** Only superadmins may assign or unassign the role; the
   *  backend refuses everyone else with RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN. */
  isSuperAdmin: boolean;
  /** False during a read-only impersonation — writes would 403. */
  canWrite: boolean;
}

/**
 * The system org's two built-in ECOSYSTEM role rosters.
 *
 * They stay HERE, on the Ecosystem console, rather than moving to Platform
 * staffing with the other job Roles: the people who assign them are the people
 * running the moderation queue, and the queue is on this page. What this no
 * longer does is implement the roster — `SystemOrgRoleRoster` does, and this is
 * the configuration of it. Near-identical hand-written panels was the
 * alternative, and the rules they share (read the Role by its seeded name,
 * superadmin-only assignment, candidates are active system-org members) are
 * exactly the rules that must not drift between them.
 *
 * TWO rosters because the permissions are two jobs: moderating what publishes
 * (`plugins:moderate`) and vouching for who publishes (`publishers:verify`).
 * See `ECOSYSTEM_MANAGER_PERMISSIONS` in api-core for why bundling them was
 * wrong. Verified applications and unsuspends are two-person, so the verifier
 * roster wants at least two names in it — empty or single-handed, those
 * decisions cannot complete, and the queue's approver notice says so.
 */
export function EcosystemManagersPanel({ isSuperAdmin, canWrite }: Props) {
  return (
    <div className="space-y-4">
      <SystemOrgRoleRoster
        roleName={ECOSYSTEM_MANAGER_ROLE_NAME}
        title="Ecosystem Managers"
        icon={Users}
        description="System-org members who approve listings and versions, and moderate reviews and submissions."
        emptyDescription="Until someone holds the role, superadmins receive every moderation notice."
        isSuperAdmin={isSuperAdmin}
        canWrite={canWrite}
      />
      <SystemOrgRoleRoster
        roleName={PUBLISHER_VERIFIER_ROLE_NAME}
        title="Publisher Verifiers"
        icon={BadgeCheck}
        description="System-org members who award Verified status, suspend publishers and lift suspensions. Awarding Verified and lifting a suspension each need two different verifiers."
        emptyDescription="Until two people hold the role, no Verified application or unsuspend can be completed without a superadmin."
        isSuperAdmin={isSuperAdmin}
        canWrite={canWrite}
      />
    </div>
  );
}
