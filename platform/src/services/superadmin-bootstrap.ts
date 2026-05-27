// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap path for granting the first `isSuperAdmin` flag in a fresh
 * deployment.
 *
 * Background: sysadmin authority is granted by setting `User.isSuperAdmin =
 * true`. Today there's no in-product flow to set the flag (granting it
 * would itself require sysadmin authority — chicken and egg). A brand-new
 * install would therefore have NO sysadmin until an operator shelled into
 * Mongo and updated the document by hand. This module closes that gap.
 *
 * How it works: at platform startup the operator sets
 * `BOOTSTRAP_SUPERADMIN_EMAILS=alice@example.com,bob@example.com`. On boot
 * we look up each email in the User collection and idempotently set
 * `isSuperAdmin=true`. Already-promoted users are no-ops. Missing emails
 * log a WARNING and don't fail startup — the user might create the account
 * later via the OAuth/registration flow, and the next boot will promote
 * them automatically.
 *
 * Security note: this env should be set ONLY in environments the operator
 * controls (their own k8s cluster / docker-compose, NOT a shared SaaS
 * tenancy). A bad value here grants sysadmin to whoever owns the email
 * address, which is exactly the operator's intent in a self-hosted deploy.
 * For Pipeline Builder's hosted SaaS the env is unset in customer
 * environments — the platform-team's own production runs it pointed at
 * the on-call rotation's group inbox.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { User } from '../models';
import AuditEvent from '../models/audit-event';

const logger = createLogger('superadmin-bootstrap');

/**
 * Promote any user whose email is in `BOOTSTRAP_SUPERADMIN_EMAILS` to
 * super-admin. Idempotent; safe to call on every boot.
 *
 * Returns the count of users actually promoted on this run (zero on a
 * warm boot where every listed user is already a sysadmin).
 */
export async function bootstrapSuperAdmins(): Promise<number> {
  const raw = process.env.BOOTSTRAP_SUPERADMIN_EMAILS || '';
  const emails = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (emails.length === 0) return 0;

  // Pull the BEFORE state of every targeted user so we can audit-log a
  // per-user `grant` event for each one actually flipped. Mongo's
  // updateMany doesn't return the matched documents, only counts, so this
  // pre-read is necessary to enumerate which users were just promoted.
  const targetedBefore = await User.find({ email: { $in: emails } })
    .select('_id email isSuperAdmin')
    .lean();
  const newlyPromoted = (targetedBefore as Array<{ _id: { toString(): string }; email: string; isSuperAdmin?: boolean }>)
    .filter((u) => u.isSuperAdmin !== true);

  // updateMany with `isSuperAdmin: { $ne: true }` filter lets Mongo skip
  // already-promoted users — keeps the boot path cheap on warm restarts
  // and avoids overwriting an existing `true` (idempotent by construction).
  const result = await User.updateMany(
    { email: { $in: emails }, isSuperAdmin: { $ne: true } },
    { $set: { isSuperAdmin: true } },
  );

  const promotedCount = result.modifiedCount ?? 0;
  if (promotedCount > 0) {
    logger.warn('Promoted users to super-admin via BOOTSTRAP_SUPERADMIN_EMAILS', {
      emails,
      promotedCount,
    });

    // Audit-log each promotion. Fire-and-forget; the loud WARN above
    // already captured the change for log searches, and we'd rather start
    // HTTP than block on the audit collection. `actorId='bootstrap-env'`
    // distinguishes deploy-time promotions from a future interactive
    // sysadmin-grant flow.
    for (const u of newlyPromoted) {
      AuditEvent.create({
        action: 'admin.superadmin.grant',
        actorId: 'bootstrap-env',
        targetType: 'user',
        targetId: u._id.toString(),
        details: { email: u.email, source: 'BOOTSTRAP_SUPERADMIN_EMAILS' },
      }).catch((err) => {
        logger.warn('Audit log write failed for super-admin grant', {
          email: u.email,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  // Distinguish "promoted on this boot" from "would-be promoted if account
  // existed" — the difference is operationally meaningful. The operator
  // wants a loud heads-up when a listed email never showed up so they can
  // re-check the spelling / wait for the user to register.
  const foundEmails = new Set(
    (targetedBefore as Array<{ email: string }>).map((u) => u.email.toLowerCase()),
  );
  const missing = emails.filter((e) => !foundEmails.has(e));
  if (missing.length > 0) {
    logger.warn('Bootstrap super-admin email(s) have no matching user account yet', {
      missing,
      hint: 'These users will be auto-promoted on the next boot after they register.',
    });
  }

  return promotedCount;
}

/**
 * Check whether a just-registered user should be auto-promoted to
 * super-admin based on `BOOTSTRAP_SUPERADMIN_EMAILS`. Called from the
 * registration controller so the promotion happens on first login — not
 * on the next platform restart.
 *
 * Returns `true` if the user was promoted.
 */
export async function maybePromoteNewUser(userId: string, email: string): Promise<boolean> {
  const raw = process.env.BOOTSTRAP_SUPERADMIN_EMAILS || '';
  const emails = new Set(
    raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
  if (emails.size === 0 || !emails.has(email.trim().toLowerCase())) return false;

  const result = await User.updateOne(
    { _id: userId, isSuperAdmin: { $ne: true } },
    { $set: { isSuperAdmin: true } },
  );
  if (!result.modifiedCount) return false;

  logger.warn('Auto-promoted newly registered user to super-admin', {
    email,
    userId,
    source: 'BOOTSTRAP_SUPERADMIN_EMAILS',
  });

  AuditEvent.create({
    action: 'admin.superadmin.grant',
    actorId: 'bootstrap-env',
    targetType: 'user',
    targetId: userId,
    details: { email, source: 'BOOTSTRAP_SUPERADMIN_EMAILS', trigger: 'registration' },
  }).catch((err) => {
    logger.warn('Audit log write failed for post-registration super-admin grant', {
      email,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return true;
}
