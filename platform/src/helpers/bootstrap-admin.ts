// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The BOOTSTRAP-ADMIN MFA exception (#8, revision 4).
 *
 * A fresh install has exactly one admin and no enrolled factor. Requiring MFA
 * would lock out the only person who can enrol one, and an HTTP recovery route
 * would be a permanent bypass of the very thing being required — so the
 * exception is narrow, self-closing and audited:
 *
 *   - It applies ONLY to an account whose email is in
 *     `BOOTSTRAP_SUPERADMIN_EMAILS` and whose active org is the system org.
 *   - While it is OPEN the person's password sign-in yields an `aal: 1` session
 *     flagged `mfaEnrollmentPending`, which reaches only enrolment, sign-out and
 *     the routes `init-platform.sh` calls ({@link BOOTSTRAP_SESSION_ALLOWLIST}).
 *     Every other service refuses such a token outright (api-core `requireAuth`).
 *   - It CLOSES permanently at the first enrolment of any factor
 *     (`User.mfaBootstrapClosedAt`) and never reopens, even if that factor is
 *     later removed.
 *   - System-org "require MFA" cannot be turned on while it is still open.
 *   - Every exception sign-in is audited `auth.mfa.bootstrap_session`, and one
 *     that happens more than {@link BOOTSTRAP_ALERT_AFTER_MS} after the install
 *     raises `platform_mfa_bootstrap_session_total{late="true"}` — a fresh
 *     install finishes in minutes, so a late one is either a stalled setup or
 *     someone using the exception as a way in.
 *   - Losing every factor afterwards is recovered with an operator command run
 *     against the database (`src/scripts/mfa-recover.ts`), never a route.
 *   - SSO enforcement never applies to a bootstrap admin: SSO refuses
 *     superadmins, so a verified, SSO-enforced domain matching their email would
 *     otherwise close BOTH sign-in paths.
 */

import { createLogger, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import type { UserDocument } from '../models/user.js';
import { incCounter } from '../observability/metrics.js';

const logger = createLogger('bootstrap-admin');

/**
 * Count something, never at the cost of the thing being counted. The metrics
 * registry is wired at app boot, so a caller that runs outside one (an operator
 * script, a test) would otherwise see a sign-in or an enrolment fail because a
 * counter had nowhere to go.
 */
function meter(name: string, labels?: Record<string, string>): void {
  try {
    incCounter(name, labels);
  } catch {
    // No registry (script / test context) — nothing to record, nothing to break.
  }
}

/** A bootstrap session older than this since the install is worth alerting on. */
export const BOOTSTRAP_ALERT_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Is this email operator-authorized as a platform super-admin (listed in
 * `BOOTSTRAP_SUPERADMIN_EMAILS`)? Env is read LIVE rather than cached, so an
 * operator can change the list without a redeploy, and it is unset in
 * customer/SaaS environments (where no caller is ever authorized).
 */
export function isBootstrapSuperAdminEmail(email: string | undefined): boolean {
  if (!email) return false;
  const raw = process.env.BOOTSTRAP_SUPERADMIN_EMAILS || '';
  const allow = new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
  return allow.size > 0 && allow.has(email.trim().toLowerCase());
}

/**
 * Write one audit event, best-effort and lazily.
 *
 * LAZY because `helpers/audit.ts` reaches the audit model and the hash-chain
 * store, and this module is imported by `middleware/auth.ts` — which runs on
 * every request and must not gain that graph in its static imports.
 * BEST-EFFORT because a sign-in must not fail for want of its own trail; the
 * refusal it records is already enforced by the time this runs.
 */
async function writeAudit(req: Request, action: 'auth.mfa.bootstrap_session' | 'auth.mfa.bootstrap_closed', fields: Record<string, unknown>): Promise<void> {
  try {
    const { audit } = await import('./audit.js');
    audit(req, action, fields as Parameters<typeof audit>[2]);
  } catch (error) {
    logger.warn('Could not write a bootstrap-exception audit event', { action, error });
  }
}

/**
 * Every model this module touches is imported ON DEMAND.
 *
 * `controllers/auth.ts` imports this for the sign-in check, and the sign-in path
 * must not gain the WebAuthn/TOTP model graph in its STATIC imports just to
 * learn the answer is "no exception" for every account but one. The same
 * reasoning as `auth-factors.ts`'s lazy provider dependencies.
 */

/** The factor state of an account: does it have a passkey or an active TOTP? */
export async function hasAnyMfaFactor(userId: string): Promise<boolean> {
  // Lazily imported for the same reason `auth-factors.ts` does it: a sign-in
  // shouldn't pull the WebAuthn + TOTP model graph in just to learn the answer
  // is `false` for most accounts.
  const { WebAuthnCredential, UserTotp } = await import('../models/index.js');
  const [passkey, totp] = await Promise.all([
    WebAuthnCredential.exists({ userId }),
    UserTotp.exists({ userId, activatedAt: { $ne: null } }),
  ]);
  return !!passkey || !!totp;
}

/**
 * Whether the exception is OPEN for `user` right now: an operator-authorized
 * email, a member of the system org, never closed before, and still with no
 * enrolled factor. Fails CLOSED — anything it cannot establish means "no
 * exception", which costs at most a re-run of `init-platform.sh`.
 */
export async function isBootstrapExceptionOpen(user: Pick<UserDocument, '_id' | 'email' | 'mfaBootstrapClosedAt'>): Promise<boolean> {
  if (!isBootstrapSuperAdminEmail(user.email)) return false;
  if (user.mfaBootstrapClosedAt) return false;
  const userId = user._id.toString();
  const { UserOrganization } = await import('../models/index.js');
  const inSystemOrg = await UserOrganization.exists({ userId, organizationId: SYSTEM_ORG_ID, isActive: true });
  if (!inSystemOrg) return false;
  return !(await hasAnyMfaFactor(userId));
}

/**
 * Close the exception for `userId`, once. Called from every enrolment path (a
 * passkey registration, a TOTP activation) — including one performed by a
 * different admin on their own account, where it is simply a no-op because the
 * field is only ever set for an account that had the exception open.
 *
 * Idempotent, and deliberately a conditional write: the FIRST enrolment is the
 * moment worth recording, so a later one must not move the timestamp.
 *
 * @returns true when this call is what closed it.
 */
export async function closeBootstrapException(userId: string): Promise<boolean> {
  const { User } = await import('../models/index.js');
  const result = await User.updateOne(
    { _id: userId, mfaBootstrapClosedAt: { $exists: false } },
    { $set: { mfaBootstrapClosedAt: new Date() } },
  );
  return result.modifiedCount > 0;
}

/**
 * Close the exception because `userId` just enrolled a factor, and record it.
 *
 * Also clears `mfaEnrollmentPending` from the person's refresh-session slots, so
 * the session they enrolled from stops being REACH-LIMITED the moment the reason
 * for the limit is gone — otherwise the admin would be stranded on a session
 * that can no longer do anything but enrol a factor it has already enrolled.
 * That does NOT raise its assurance: the slot is still `aal: 1`, so any route
 * with `minAssurance: 2` (and any org that requires MFA) still sends them back
 * to sign in with the new factor. Raising `aal` on anything but a fresh sign-in
 * is exactly what #8 forbids.
 *
 * A no-op for every account that never had the exception open.
 */
export async function closeBootstrapExceptionOnEnrolment(req: Request, userId: string): Promise<void> {
  if (!(await closeBootstrapException(userId))) return;
  const { User } = await import('../models/index.js');
  await User.updateOne(
    { _id: userId },
    { $unset: { 'refreshSessions.$[].mfaEnrollmentPending': '' } },
  );
  meter('platform_mfa_bootstrap_closed_total');
  logger.info('Bootstrap-admin MFA exception closed by a first enrolment', { userId });
  await writeAudit(req, 'auth.mfa.bootstrap_closed', { targetType: 'user', targetId: userId });
}

/** When this install came up — the system org's creation time. Used to decide
 *  whether a bootstrap session is suspiciously late. `null` when the system org
 *  doesn't exist yet (the register step itself). */
export async function installedAt(): Promise<Date | null> {
  const { Organization } = await import('../models/index.js');
  const org = await Organization.findById(SYSTEM_ORG_ID).select('createdAt').lean();
  return (org as { createdAt?: Date } | null)?.createdAt ?? null;
}

/**
 * Record that the exception was used to open a session: an audit event on every
 * one, and a counter labelled `late` when it happens more than
 * {@link BOOTSTRAP_ALERT_AFTER_MS} after the install.
 *
 * A fresh install finishes in minutes, so a late bootstrap session is either a
 * setup that stalled without ever enrolling a factor or someone using the
 * exception as a way in — both worth an alert (see the
 * `PlatformMfaBootstrapSessionLate` rule in the deploy alert rules).
 *
 * Best-effort: a sign-in must not fail because its trail couldn't be written.
 */
export async function recordBootstrapSession(req: Request, userId: string, email: string): Promise<void> {
  let late = false;
  try {
    const since = await installedAt();
    late = !!since && Date.now() - since.getTime() > BOOTSTRAP_ALERT_AFTER_MS;
  } catch (error) {
    logger.warn('Could not resolve install time for a bootstrap session', { error });
  }
  meter('platform_mfa_bootstrap_session_total', { late: String(late) });
  if (late) {
    logger.warn('Bootstrap-admin MFA exception used long after install — the admin has still not enrolled a factor', { userId, email });
  }
  await writeAudit(req, 'auth.mfa.bootstrap_session', {
    targetType: 'user',
    targetId: userId,
    details: { email, late },
  });
}

/**
 * Everything an `mfaEnrollmentPending` session may reach on PLATFORM, as
 * `METHOD /path` prefixes matched against the request's path.
 *
 * Three groups, and nothing else:
 *   1. ENROLMENT — registering a passkey or an authenticator app, plus the
 *      profile read the enrolment screen needs to know which factors exist, and
 *      step-up (enrolling a second factor is step-up gated).
 *   2. LEAVING — sign-out, and the refresh that keeps the enrolment screen alive
 *      long enough to finish.
 *   3. SETUP — exactly the calls `deploy/bin/init-platform.sh` makes between the
 *      admin's login and the moment it switches to the `setup` service-account
 *      key: read the org, read its roles, create the service account, list/read
 *      it, and issue + revoke its keys. Everything after that runs as the
 *      service account, which is a machine principal and never carries this flag.
 */
const BOOTSTRAP_SESSION_ALLOWLIST: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  // 1. Enrolment
  { method: 'GET', pattern: /^\/user\/profile$/ },
  { method: '*', pattern: /^\/auth\/webauthn\// },
  { method: '*', pattern: /^\/auth\/totp\// },
  { method: 'POST', pattern: /^\/auth\/step-up\b/ },
  // 2. Leaving
  { method: 'POST', pattern: /^\/auth\/logout$/ },
  { method: 'POST', pattern: /^\/auth\/refresh$/ },
  // 3. Setup (init-platform.sh)
  { method: 'GET', pattern: /^\/organization$/ },
  { method: 'GET', pattern: /^\/organization\/[^/]+\/roles$/ },
  { method: '*', pattern: /^\/organization\/[^/]+\/service-accounts(\/|$)/ },
];

/**
 * Is this the bootstrap administrator making one of the SETUP calls above?
 *
 * The exception's whole premise is that a fresh install's only admin has no
 * second factor yet, so its session is `aal: 1` — which means the two setup
 * routes that mint the install's automation credential (create the `setup`
 * service account, issue its key) can never satisfy their own
 * `requireAssurance({ minAssurance: 2 })`. Before this, the allowlist admitted
 * those routes and the assurance gate then refused them with 401 `MFA_REQUIRED`:
 * `init-platform.sh` could not finish on a fresh install at all.
 *
 * So the gate takes this as a NAMED exemption (`reason: 'bootstrap-setup'`,
 * counted as `assurance_exempted_total` and published on the route table). It is
 * as narrow as the exception itself:
 *   - the token must carry `mfaEnrollmentPending` — only a bootstrap-admin
 *     sign-in mints that, only while the exception is open, and it is stored on
 *     the session slot so a refresh cannot shed it;
 *   - the request must be one {@link BOOTSTRAP_SESSION_ALLOWLIST} already admits,
 *     so the exemption can never widen the reach; and
 *   - step-up still applies. Creating the account and issuing the key each need a
 *     fresh `X-Step-Up-Token`, which the admin's password earns — so the action
 *     is still confirmed, and still audited as `org.service-account.*`.
 * It closes with the exception, at the first enrolment, and never reopens.
 */
export function isBootstrapSetupRequest(req: Request): boolean {
  const claims = (req as { user?: { mfaEnrollmentPending?: boolean } }).user;
  return claims?.mfaEnrollmentPending === true && bootstrapSessionMayReach(req);
}

/** Whether an enrolment-pending session may reach this request. Fails closed. */
export function bootstrapSessionMayReach(req: Pick<Request, 'method' | 'path'>): boolean {
  const method = req.method.toUpperCase();
  // `req.path` excludes the query string and, for a router-mounted handler, is
  // still the full path here because this runs in `requireAuth` at route level
  // on an app whose routes are mounted at their own prefixes; use the baseUrl-
  // independent `originalUrl` when present for exactness.
  const path = ((req as { originalUrl?: string }).originalUrl ?? req.path).split('?')[0];
  return BOOTSTRAP_SESSION_ALLOWLIST.some((e) => (e.method === '*' || e.method === method) && e.pattern.test(path));
}
