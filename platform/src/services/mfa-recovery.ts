// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Factor reset for an account that has lost EVERY multi-factor credential (#8).
 *
 * Lives here, not in the script, for one reason: the script's entry point ends
 * in `process.exit`, so importing it is not something a test can do — and this
 * is the ONE recovery path there is. Discovering it is broken on the day it is
 * needed is exactly the failure mode the tests exist to prevent. The command
 * (`scripts/mfa-recover.ts`) is a thin wrapper around `recoverMfa`.
 *
 * It is deliberately NOT reachable over HTTP: a route that removes someone's
 * second factor is by construction a bypass of the second factor. Requiring
 * database access instead means recovery costs the same as the rest of the
 * platform's trust.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { auditService } from './audit-service.js';
import { publishUserRevocation } from '../helpers/session-revocation.js';
import { Organization, User, UserTotp, WebAuthnCredential } from '../models/index.js';

const logger = createLogger('mfa-recovery');

/** What the reset removed, so the operator sees exactly what happened. */
export interface MfaRecoveryResult {
  userId: string;
  email: string;
  passkeysRemoved: number;
  totpRemoved: boolean;
  /** The account's `tokenVersion` AFTER the bump — every older token is dead. */
  tokenVersion: number;
  /** Set when `clearOrgPolicy` turned an org's requirement off as well. */
  orgPolicyCleared?: string;
}

export interface MfaRecoveryOptions {
  /** The account to reset, by email. */
  email: string;
  /** Who is running this. Recorded as the audit actor — the person whose factors
   *  were removed did NOT do this, and an audit row saying they did would be a
   *  lie in the one place it matters most. */
  operator: string;
  /**
   * Also turn OFF the "require MFA" policy on the account's active org.
   *
   * Needed when that org requires MFA: the reset leaves the person with no
   * factor, so without this they could not sign in at all — not even to enrol a
   * new one. Turn the policy back on once they have.
   */
  clearOrgPolicy?: boolean;
}

/**
 * Remove every factor from the account with `email`, end all of its sessions,
 * and record the reset.
 *
 * Returns `null` when no such account exists. Never reopens the bootstrap
 * exception: that closes permanently at the first enrolment (see
 * `helpers/bootstrap-admin.ts`), and re-opening it here would make it permanent
 * by another name.
 */
export async function recoverMfa(opts: MfaRecoveryOptions): Promise<MfaRecoveryResult | null> {
  const user = await User.findOne({ email: opts.email.trim().toLowerCase() }).select('+tokenVersion email lastActiveOrgId');
  if (!user) return null;
  const userId = user._id.toString();

  const [passkeys, totp] = await Promise.all([
    WebAuthnCredential.deleteMany({ userId }),
    UserTotp.deleteOne({ userId }),
  ]);

  // Bump `tokenVersion` AND clear the slots — the same "sign out everywhere" the
  // service performs. A reset that left a live session behind would be a reset
  // in name only.
  const updated = await User.findByIdAndUpdate(
    user._id,
    { $inc: { tokenVersion: 1 }, $set: { refreshSessions: [] } },
    { new: true },
  ).select('+tokenVersion').lean();
  await publishUserRevocation(userId);

  let orgPolicyCleared: string | undefined;
  if (opts.clearOrgPolicy && user.lastActiveOrgId) {
    await Organization.updateOne(
      { _id: user.lastActiveOrgId },
      { $set: { requireMfa: false }, $unset: { mfaRequiredSince: '', mfaGraceUntil: '' } },
    );
    orgPolicyCleared = String(user.lastActiveOrgId);
  }

  const result: MfaRecoveryResult = {
    userId,
    email: user.email,
    passkeysRemoved: passkeys.deletedCount ?? 0,
    totpRemoved: (totp.deletedCount ?? 0) > 0,
    tokenVersion: (updated as { tokenVersion?: number } | null)?.tokenVersion ?? 0,
    ...(orgPolicyCleared ? { orgPolicyCleared } : {}),
  };

  // Awaited, not fire-and-forget: if the trail cannot be written the command
  // must fail rather than quietly reset a factor with no record of it.
  await auditService.createEvent({
    action: 'auth.mfa.operator_reset',
    actorId: opts.operator,
    actorEmail: opts.operator,
    targetType: 'user',
    targetId: userId,
    outcome: 'success',
    details: {
      email: result.email,
      passkeysRemoved: result.passkeysRemoved,
      totpRemoved: result.totpRemoved,
      ...(orgPolicyCleared ? { orgPolicyCleared } : {}),
      via: 'operator-command',
    },
  });

  logger.warn('Multi-factor credentials reset by an operator', { ...result, operator: opts.operator });
  return result;
}
