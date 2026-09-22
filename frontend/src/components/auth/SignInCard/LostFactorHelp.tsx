// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The operator command for the case the dashboard can't reach — nobody able to
 *  sign in to approve a reset (platform `src/scripts/mfa-recover.ts`). */
const MFA_RECOVER_COMMAND = 'node scripts/mfa-recover.js --email <your address>';

/**
 * What to do when every second factor is gone.
 *
 * Shown on demand at the two places the dead end is actually reached: under the
 * code step (the app is gone AND the recovery codes are gone) and under the
 * org-policy refusal (the requirement bites and there is no factor to meet it).
 * Recovery is never self-service — anything that removed a factor on request
 * would be a way around it — so the honest answer is WHO to ask: two admins of
 * the organization (one requests, a different one approves), a platform
 * administrator for an org with no second admin, or the operator command when
 * nobody can sign in at all.
 */
export function LostFactorHelp() {
  return (
    <div className="rounded-xl border border-default bg-surface-muted p-3 text-left space-y-2">
      <p className="text-xs font-normal leading-relaxed text-fg-muted">
        Two-factor authentication can’t be turned off from a sign-in page — there is
        deliberately no self-service route, because anything that removed your second
        factor on request would be a way around it.
      </p>
      <p className="text-xs font-normal leading-relaxed text-fg-muted">
        Ask an owner or admin of your organization to reset your two-factor authentication
        from its Members page; a <strong>second</strong> owner or admin approves it. If your
        organization has no second admin, a platform administrator can reset it instead.
      </p>
      <p className="text-xs font-normal leading-relaxed text-fg-muted">
        The reset removes every passkey, the authenticator app and the recovery codes, signs
        the account out everywhere, and is recorded in the audit trail under the people who
        did it. You then have a few days to sign in with your password and enrol a new factor
        — your organization&apos;s policy is not relaxed for anyone else.
      </p>
      <p className="text-xs font-normal leading-relaxed text-fg-muted">
        If nobody can sign in to do that, whoever operates Pipeline Builder runs:
      </p>
      <code className="block p-2 rounded-lg text-2xs font-mono bg-surface text-fg break-all">
        {MFA_RECOVER_COMMAND}
      </code>
    </div>
  );
}
