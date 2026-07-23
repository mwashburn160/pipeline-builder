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
import { auditService } from './audit-service.js';
import { grantPlatformAdmin } from './roles-service.js';
import { User } from '../models/index.js';

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

  // Pull the state of every targeted user so we can drive the grant per-user and
  // audit-log each one actually flipped. `grantPlatformAdmin` doesn't return the
  // matched emails, so this read is what maps user id → email for the audit rows.
  const targetedBefore = await User.find({ email: { $in: emails } })
    .select('_id email isSuperAdmin')
    .lean() as Array<{ _id: { toString(): string }; email: string; isSuperAdmin?: boolean }>;

  // Route the promotion through `grantPlatformAdmin` (roles-service) rather than a
  // bare `isSuperAdmin=true` write. That path assigns the system-org Super Admin
  // Role AND bumps `tokenVersion` — so (1) a later `recomputeUserOrgRole` re-derives
  // the flag from the persisted assignment instead of silently clearing it, and
  // (2) an existing session gains superadmin on its next refresh instead of only at
  // re-login. It is idempotent + self-healing: an already-granted user is a no-op
  // (`changed:false`); a legacy flag-only user gets the missing Role assignment
  // added with no session churn. We run it for EVERY found user (not just the
  // not-yet-flagged ones) so those legacy flag-only rows get healed too.
  const newlyPromoted: Array<{ _id: { toString(): string }; email: string }> = [];
  for (const u of targetedBefore) {
    try {
      const { changed } = await grantPlatformAdmin(u._id.toString());
      if (changed) newlyPromoted.push(u);
    } catch (err) {
      // Non-fatal per user (e.g. the system-org Super Admin Role isn't seeded yet
      // on a brand-new install) — log and keep promoting the rest; the next boot
      // retries once the system org exists.
      logger.warn('Super-admin grant failed for bootstrap email', {
        email: u.email,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const promotedCount = newlyPromoted.length;
  if (promotedCount > 0) {
    logger.warn('Promoted users to super-admin via BOOTSTRAP_SUPERADMIN_EMAILS', {
      emails: newlyPromoted.map((u) => u.email),
      promotedCount,
    });

    // Audit-log each promotion. Fire-and-forget; the loud WARN above
    // already captured the change for log searches, and we'd rather start
    // HTTP than block on the audit collection. `actorId='bootstrap-env'`
    // distinguishes deploy-time promotions from a future interactive
    // sysadmin-grant flow.
    for (const u of newlyPromoted) {
      auditService.createEvent({
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

  // Route through `grantPlatformAdmin` (roles-service) instead of a bare
  // `isSuperAdmin=true` write: it assigns the system-org Super Admin Role AND
  // bumps `tokenVersion`, so the flag survives a later `recomputeUserOrgRole`
  // (no silent self-demotion) and takes effect on the next refresh. Idempotent —
  // `changed:false` means the user was already a superadmin (no-op).
  const { changed } = await grantPlatformAdmin(userId);
  if (!changed) return false;

  logger.warn('Auto-promoted newly registered user to super-admin', {
    email,
    userId,
    source: 'BOOTSTRAP_SUPERADMIN_EMAILS',
  });

  auditService.createEvent({
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
