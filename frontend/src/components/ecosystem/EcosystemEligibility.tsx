// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CheckCircle2, CircleHelp, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import type { ApproverStanding, VerifiedCheckId, VerifiedEligibility } from '@/types/ecosystem';

export const VERIFIED_CHECK_LABELS: Record<VerifiedCheckId, string> = {
  plan: 'Plan',
  domain: 'Verified domain',
  owner_mfa: 'Owner MFA',
};

/**
 * The automatic Verified-eligibility checks — plan, a DNS-verified
 * domain, owner MFA — as a compact badge row (`compact`) or a list with each
 * check's detail. `ok: null` means platform couldn't answer (the server treats
 * that as a refusal).
 */
export function VerifiedEligibilityChecks({ eligibility, compact = false, title }: {
  eligibility: VerifiedEligibility;
  compact?: boolean;
  title?: string;
}) {
  if (compact) {
    return (
      <span className="inline-flex flex-wrap gap-1" data-testid="verified-checks">
        {eligibility.checks.map((c) => (
          <Badge key={c.id} color={c.ok === true ? 'green' : c.ok === false ? 'red' : 'gray'}>
            <span title={c.detail}>{VERIFIED_CHECK_LABELS[c.id]}{c.ok === true ? ' ✓' : c.ok === false ? ' ✗' : ' ?'}</span>
          </Badge>
        ))}
      </span>
    );
  }
  return (
    <div className="space-y-1.5 rounded-lg border border-default p-3" data-testid="verified-eligibility">
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
        {title ?? 'Verified eligibility'}
        <Badge color={eligibility.eligible ? 'green' : 'red'}>{eligibility.eligible ? 'Eligible' : 'Not eligible'}</Badge>
      </div>
      <ul className="space-y-1 text-xs">
        {eligibility.checks.map((c) => {
          const Icon = c.ok === true ? CheckCircle2 : c.ok === false ? XCircle : CircleHelp;
          const tone = c.ok === true ? 'text-success-strong' : c.ok === false ? 'text-danger-strong' : 'text-fg-muted';
          return (
            <li key={c.id} className="flex items-start gap-1.5">
              <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} aria-hidden />
              <span>
                <span className="font-medium text-fg">{VERIFIED_CHECK_LABELS[c.id]}:</span>{' '}
                <span className="text-fg-muted">{c.detail}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The approver headroom warning. For the
 * console as a whole (`scope="console"`): below two Ecosystem Managers a
 * superadmin must be the second approver; below three there is no holiday
 * cover. For one request (`scope="request"`): how many could still decide it
 * after the requester's conflicts. Renders nothing while the count is unknown.
 */
export function ApproverStandingNotice({ standing, minimum = 3, scope, requiresTwoPerson = true }: {
  standing: ApproverStanding | null | undefined;
  minimum?: number;
  scope: 'console' | 'request';
  requiresTwoPerson?: boolean;
}) {
  const count = standing?.count;
  if (!standing || !count) return null;
  if (scope === 'request') {
    const who = standing.permission === 'publishers:verify' ? 'publisher-verification' : 'moderation';
    return (
      <p className={`text-xs ${standing.belowTwoPerson && requiresTwoPerson ? 'text-warning-strong' : 'text-fg-muted'}`} data-testid="request-approvers">
        {count.eligible} of {count.holders} Ecosystem Manager{count.holders === 1 ? '' : 's'} with {who} rights can decide this
        request (the rest have a conflict of interest){count.superadmins > 0 ? `; ${count.superadmins} superadmin${count.superadmins === 1 ? '' : 's'} can also act` : ''}.
        {standing.belowTwoPerson && requiresTwoPerson && ' Two-person approval will need a superadmin.'}
      </p>
    );
  }
  if (standing.belowTwoPerson) {
    return (
      <Callout variant="warning" title="Fewer than two Ecosystem Managers">
        Only {count.holders} system-org member{count.holders === 1 ? ' holds' : 's hold'} the Ecosystem Manager permissions, so
        two-person approvals need a superadmin as the other approver. Keep at least {minimum}: add managers on the
        Ecosystem Managers tab.
      </Callout>
    );
  }
  if (standing.belowMinimum) {
    return (
      <Callout variant="warning" title={`Below ${minimum} Ecosystem Managers`}>
        {count.holders} managers can cover two-person approval today, but not an absence. Keep at least
        {' '}{minimum}.
      </Callout>
    );
  }
  return null;
}
