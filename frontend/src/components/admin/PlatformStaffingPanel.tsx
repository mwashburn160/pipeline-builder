// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { BadgeCheck, Landmark, LifeBuoy, Wrench } from 'lucide-react';
import { Callout } from '@/components/ui/Callout';
import { SystemOrgRoleRoster } from '@/components/admin/SystemOrgRoleRoster';
import { SYSTEM_ORG_JOB_ROLES } from '@/lib/system-org-roles';

/** One icon per job, so the four rosters are distinguishable at a glance. */
const ICONS: Record<string, typeof Wrench> = {
  'Platform Operator': Wrench,
  'Account Manager': Landmark,
  'Console Administrator': BadgeCheck,
  'Support Agent': LifeBuoy,
};

interface Props {
  /** Only superadmins may assign a system-org Role; everyone else reads. */
  isSuperAdmin: boolean;
  /** False during a read-only impersonation — writes would 403. */
  canWrite: boolean;
}

/**
 * **Platform staffing** — who does each of the vendor's own jobs.
 *
 * WHY THIS EXISTS. Every permission behind these Roles is system-org-only, so no
 * Role authored in a TENANT may carry one — a superadmin can still compose a
 * custom Role inside the system org that does (platform's `sanitizePermissions`,
 * `mayComposeSystemOrgRole`), which is the escape hatch for a job no seeded Role
 * covers. For the jobs below, assigning the seeded Role is the path that does
 * not require composing anything. The generic Role admin can do
 * that — it is the same two routes underneath — but it asks the operator to know
 * which of six Roles maps to which job, and to go looking for the system org's
 * Role list to find out. The observed outcome of that is people reaching for the
 * Super Admin flag instead, which is the exact failure these Roles were added to
 * remove, so the surface matters as much as the permissions do.
 *
 * It also answers the question an operator actually has, which the Role admin
 * cannot: "who can open a database shell / cancel a subscription / see our
 * customers' cases?" — one page instead of an audit of every Role.
 *
 * WHAT IT DOES NOT DO. It never grants Super Admin; see
 * `lib/system-org-roles.ts` for why that stays on its own route with its own
 * step-up.
 */
export function PlatformStaffingPanel({ isSuperAdmin, canWrite }: Props) {
  return (
    <div className="space-y-4">
      <Callout variant="neutral" title="Staffing a job does not hand over the platform">
        None of these Roles sets the Super Admin flag, opens an impersonation session, or can grant
        itself more. Each carries only the permissions its job needs, and every one of them is
        system-org-only — so none can be held by anyone inside a customer organization.
        {!isSuperAdmin && ' Only superadmins can assign them.'}
      </Callout>
      {SYSTEM_ORG_JOB_ROLES.map((role) => (
        <SystemOrgRoleRoster
          key={role.name}
          roleName={role.name}
          title={role.name}
          icon={ICONS[role.name]}
          description={role.description}
          emptyDescription={role.emptyDescription}
          isSuperAdmin={isSuperAdmin}
          canWrite={canWrite}
        />
      ))}
    </div>
  );
}
