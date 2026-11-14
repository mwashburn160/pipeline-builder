// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AccountDeletionPlan } from '@/lib/api/domains/auth';

type Blocker = AccountDeletionPlan['blockedBy'][number];

/** Why one owned org stops the account from being deleted, and what to do. */
export function blockerText(b: Blocker): string {
  switch (b.reason) {
    case 'other-members':
      return `has ${b.otherMembers} other member${b.otherMembers === 1 ? '' : 's'} — transfer ownership first`;
    case 'has-teams':
      return 'has teams — delete or move them first';
    case 'system-org':
      return 'is the platform\'s system organization and cannot be deleted with an account';
  }
}

/** The reason the Delete button is disabled, or null when the plan allows it. */
export function deletionBlockedReason(plan: AccountDeletionPlan): string | null {
  if (plan.canDelete) return null;
  return plan.blockedBy.length === 1
    ? `Your organization ${plan.blockedBy[0].name} ${blockerText(plan.blockedBy[0])}.`
    : 'Organizations you own must be handed on first — see the list above.';
}

/**
 * What deleting the account will do, from `GET /user/account/deletion`: which
 * owned orgs go with it (the caller is their only member — recoverable by
 * support for 30 days, the org soft-delete window) and which block it.
 * Rendered as the step-up dialog's `details`, so the one dialog that confirms
 * the delete also says which case applies.
 */
export function AccountDeletionDetails({ plan }: { plan: AccountDeletionPlan }) {
  return (
    <>
      <p>Your account is removed and anything authenticating as you stops working.</p>
      {plan.orgsDeleted.length > 0 && (
        <div data-testid="orgs-deleted">
          <p>
            {plan.orgsDeleted.length === 1 ? 'This organization has' : 'These organizations have'} no other members and
            {plan.orgsDeleted.length === 1 ? ' is' : ' are'} deleted with your account, with everything in
            {plan.orgsDeleted.length === 1 ? ' it' : ' them'} (recoverable by support for 30 days):
          </p>
          <ul className="list-disc pl-5">
            {plan.orgsDeleted.map((o) => <li key={o.orgId}><strong>{o.name || o.orgId}</strong></li>)}
          </ul>
        </div>
      )}
      {plan.blockedBy.length > 0 && (
        <div data-testid="orgs-blocking" className="text-danger">
          <p>You own {plan.blockedBy.length === 1 ? 'an organization' : 'organizations'} that cannot be deleted with your account:</p>
          <ul className="list-disc pl-5">
            {plan.blockedBy.map((b) => <li key={b.orgId}><strong>{b.name || b.orgId}</strong> {blockerText(b)}.</li>)}
          </ul>
        </div>
      )}
      {plan.canDelete && <p className="text-danger">This cannot be undone.</p>}
    </>
  );
}
