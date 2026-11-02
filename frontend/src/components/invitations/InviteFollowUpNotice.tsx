// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import type { OrgMfaPolicy } from '@/types';

/** What each coarse invitation role actually grants on acceptance. Mirrors
 *  api-core's `ROLE_PERMISSIONS` seed bundles — the built-in Role the new
 *  member is placed on. */
const ROLE_SUMMARY: Record<'admin' | 'member', { grants: string; withholds: string }> = {
  member: {
    grants: 'read and write on pipelines, templates and plugins, plus read access to compliance, dashboards, reports, billing and quotas',
    withholds: 'managing members, roles, invitations, billing or org settings — and no publish rights on any catalog',
  },
  admin: {
    grants: 'full administration of this organization: members, roles, invitations, settings, billing, compliance and every catalog (including publish)',
    withholds: 'platform-operator actions (the plugin registry, cross-org administration), which stay with system admins',
  },
};

/** Props for {@link InviteFollowUpNotice}. */
interface InviteFollowUpNoticeProps {
  /** Org the invitations are sent for — used to read the effective MFA policy. */
  orgId: string | undefined;
  /** The coarse role currently selected in the send form. */
  role: 'admin' | 'member';
  /** Whether the org parents at least one team (drives the team wording). */
  hasTeams: boolean;
  /** How many Roles the invitation will grant on acceptance. */
  rolesChosen: number;
}

/**
 * The honest half of the invite form.
 *
 * ONE OF ITS TWO CLAIMS STOPPED BEING TRUE. It used to say an invitation cannot
 * carry a Role, which was the point of the notice — the sender had to go and
 * assign one afterwards. Invitations take `roleIds` now (see
 * `InviteRolePicker`), so that line is gone when Roles are chosen and softened
 * to a prompt when they are not: "no Roles selected" is a real condition worth
 * naming, but it is no longer a limitation of the invitation.
 *
 * What remains genuinely post-acceptance:
 *
 *   - Teams — `POST /organization/:id/members/bulk-add` resolves a real User,
 *     so a not-yet-accepted invitee cannot be placed on a team at invite time.
 *     Members → Manage teams (or Add to team) does it after acceptance.
 *
 * And one thing that can stop the invitee at the door: an org that requires a
 * second factor blocks the first sign-in until they enrol. The policy read is
 * best-effort — it is gated on `org_settings:write`, which an `invitations:manage`
 * holder may not have, so a failure renders nothing rather than an error.
 */
export function InviteFollowUpNotice({ orgId, role, hasTeams, rolesChosen }: InviteFollowUpNoticeProps) {
  const mfa = useFetch<OrgMfaPolicy | null>(async (signal) => {
    try {
      return (await api.getMfaPolicy(orgId!, { signal })).data ?? null;
    } catch {
      // 403 for an invitations-only admin — the notice simply omits the MFA line.
      return null;
    }
  }, [orgId], { enabled: !!orgId });

  const summary = ROLE_SUMMARY[role];
  const mfaRequired = mfa.data?.requireMfa === true;

  return (
    <div className="rounded-lg border border-default bg-surface-muted p-3 space-y-2" data-testid="invite-follow-up">
      <p className="text-xs text-fg-muted">
        <span className="font-medium text-fg">As {role === 'admin' ? 'an admin' : 'a member'} they get</span> {summary.grants}.
        {' '}<span className="font-medium text-fg">They won&apos;t get</span> {summary.withholds}.
      </p>
      <p className="text-xs text-fg-muted">
        {rolesChosen > 0
          ? <><span className="font-medium text-fg">On acceptance</span> they also get the {rolesChosen === 1 ? 'role' : `${rolesChosen} roles`} selected above. One thing still happens by hand afterwards:</>
          : <><span className="font-medium text-fg">After they accept</span> you still assign the rest by hand:</>}
      </p>
      <ul className="list-disc pl-5 text-xs text-fg-muted space-y-1">
        {rolesChosen === 0 && (
          <li>
            No roles selected, so they start with the coarse {role} permissions only. Fine-grained
            permissions come from <Link href="/dashboard/roles" className="action-link">Roles</Link> — pick
            them above to have them applied on acceptance, or grant them later from Members → Manage roles.
          </li>
        )}
        <li>
          {hasTeams
            ? <>Team placement happens in Members → Manage teams. Adding someone to a team needs an existing account, so it can only run once they&apos;ve accepted.</>
            : <>If you later create teams, membership of them is granted separately from Members → Manage teams.</>}
        </li>
      </ul>
      {mfaRequired && (
        <p className="text-xs text-warning-strong inline-flex items-start gap-1.5" data-testid="invite-mfa-warning">
          <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            This organization requires two-factor authentication
            {mfa.data?.inheritedFromName ? <> (inherited from {mfa.data.inheritedFromName})</> : null}
            , so the invitee must enrol a second factor at first sign-in
            {mfa.data?.graceUntil ? <> — enrolment is due by {new Date(mfa.data.graceUntil).toLocaleDateString()}</> : null}
            . Tell them to have an authenticator app or passkey ready, or they&apos;ll be blocked at the door.
          </span>
        </p>
      )}
    </div>
  );
}
