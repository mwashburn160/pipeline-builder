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
}

/**
 * The honest half of the invite form.
 *
 * An invitation only ever carries the COARSE role (`admin` | `member`), but the
 * access model has two further layers the sender has to apply themselves after
 * the invitee accepts:
 *
 *   1. Roles — the real permission sets, assigned from Members → Manage roles.
 *      An invitation can't carry one.
 *   2. Teams — `POST /organization/:id/members/bulk-add` resolves a real User,
 *      so a not-yet-accepted invitee cannot be placed on a team at invite time.
 *      Members → Manage teams (or Add to team) does it after acceptance.
 *
 * And one thing that can stop the invitee at the door: an org that requires a
 * second factor blocks the first sign-in until they enrol. The policy read is
 * best-effort — it is gated on `org:settings`, which an `invitations:manage`
 * holder may not have, so a failure renders nothing rather than an error.
 */
export function InviteFollowUpNotice({ orgId, role, hasTeams }: InviteFollowUpNoticeProps) {
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
        <span className="font-medium text-fg">After they accept</span> you still assign the rest by hand — this invitation
        can&apos;t carry either:
      </p>
      <ul className="list-disc pl-5 text-xs text-fg-muted space-y-1">
        <li>
          Fine-grained permissions come from <Link href="/dashboard/roles" className="action-link">Roles</Link>, granted per
          member from Members → Manage roles.
        </li>
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
