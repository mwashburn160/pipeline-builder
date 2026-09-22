// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An organization's security policies — two-factor, password, authenticator
 * (passkey model) and impersonation: reading them (own and effective, with the
 * stricter parent named), writing them, and the lineage rules that decide how
 * a team's setting combines with its parents'. The controllers keep only the
 * request concerns: tenancy, assurance for a loosening change, audit, response.
 */

import { listModels, type MdsModel } from './fido-mds.js';
import { PASSWORD_MAX_LENGTH } from '../constants/password.js';
import { ACTIVE_TOTP, hasActiveTotp } from '../helpers/auth-factors.js';
import { aaguidPermitted, combineAllowlists, resolveEffectiveAuthenticatorPolicy } from '../helpers/authenticator-policy.js';
import { bootstrapSuperAdminEmails, isBootstrapExceptionOpen } from '../helpers/bootstrap-admin.js';
import { IMPERSONATION_POLICIES, resolveImpersonationPolicy } from '../helpers/impersonation-policy.js';
import { DEFAULT_MFA_GRACE_DAYS, resolveEffectiveMfaPolicy, type EffectiveMfaPolicy } from '../helpers/mfa-policy.js';
import { getOrgName } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import { readOrgPolicyLineage } from '../helpers/org-policy-lineage.js';
import { resolveEffectivePasswordPolicy } from '../helpers/password-policy.js';
import { Organization, User, UserOrganization } from '../models/index.js';

/** Whether the org exists (the 404 every policy route answers otherwise). */
export async function orgExists(orgId: string): Promise<boolean> {
  return !!(await Organization.exists({ _id: toOrgId(orgId) }));
}

// -- Two-factor policy -----------------------------------------------------------

/** The stored fields a two-factor policy change is decided against, or null when the org is gone. */
export async function readMfaPolicyState(orgId: string) {
  return Organization.findById(toOrgId(orgId))
    .select('requireMfa mfaGraceUntil idpEnforcesMfa adminActionsRequireMfa isSystem').lean();
}

/** The fields a two-factor policy update may set. */
export interface MfaPolicyUpdate {
  requireMfa?: boolean;
  graceDays?: number;
  idpEnforcesMfa?: boolean;
  adminActionsRequireMfa?: boolean;
}

/**
 * Write a two-factor policy update and return the resulting EFFECTIVE policy.
 * `turningOn` (requirement off → on) starts the grace period.
 */
export async function writeMfaPolicy(orgId: string, body: MfaPolicyUpdate, turningOn: boolean): Promise<EffectiveMfaPolicy> {
  const now = new Date();
  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  if (body.requireMfa !== undefined) {
    set.requireMfa = body.requireMfa;
    if (turningOn) {
      // The deadline is computed HERE from a day count, so a client can never
      // post a deadline of its own — including one already in the past, which
      // would turn "enable with a grace period" into an instant lockout.
      const graceDays = body.graceDays ?? DEFAULT_MFA_GRACE_DAYS;
      set.mfaRequiredSince = now;
      if (graceDays > 0) set.mfaGraceUntil = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000);
      else unset.mfaGraceUntil = '';
    } else if (body.requireMfa === false) {
      // Turning it off clears the deadline too: a grace period that outlives the
      // requirement would silently resume it if the policy were re-enabled.
      unset.mfaRequiredSince = '';
      unset.mfaGraceUntil = '';
    }
  }
  if (body.idpEnforcesMfa !== undefined) set.idpEnforcesMfa = body.idpEnforcesMfa;
  if (body.adminActionsRequireMfa !== undefined) set.adminActionsRequireMfa = body.adminActionsRequireMfa;

  await Organization.updateOne(
    { _id: toOrgId(orgId) },
    {
      ...(Object.keys(set).length > 0 ? { $set: set } : {}),
      ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
    },
  );


  return resolveEffectiveMfaPolicy(orgId);
}

/**
 * Whether a policy update WEAKENS the org's protection, and therefore needs an
 * `aal: 2` session:
 *   - turning "require MFA" off;
 *   - turning "administrative actions require MFA" off;
 *   - stating that the org's IdP enforces MFA — from then on an SSO sign-in
 *     counts as `aal: 2` on the org's word rather than on a factor we verified.
 * Everything else (turning a requirement on, withdrawing the IdP statement) only
 * tightens, and stays open to a single-factor admin.
 */
export function isLooseningMfa(
  before: { requireMfa?: boolean; idpEnforcesMfa?: boolean; adminActionsRequireMfa?: boolean },
  body: { requireMfa?: boolean; idpEnforcesMfa?: boolean; adminActionsRequireMfa?: boolean },
): boolean {
  return (body.requireMfa === false && before.requireMfa === true)
    || (body.adminActionsRequireMfa === false && before.adminActionsRequireMfa === true)
    || (body.idpEnforcesMfa === true && before.idpEnforcesMfa !== true);
}

/**
 * Whether ANY bootstrap-authorized account still has the exception open. Checked
 * rather than "the caller's own", because the account that would be locked out
 * is whichever bootstrap admin has no factor — not necessarily the one making
 * this request.
 */
export async function anyOpenBootstrapException(): Promise<boolean> {
  const emails = [...bootstrapSuperAdminEmails()];
  if (emails.length === 0) return false;
  const users = await User.find({ email: { $in: emails } }).select('email mfaBootstrapClosedAt').lean();
  for (const u of users) {
    if (await isBootstrapExceptionOpen(u as Parameters<typeof isBootstrapExceptionOpen>[0])) return true;
  }
  return false;
}

/**
 * How many of the org's active members could satisfy the requirement today.
 *
 * An admin choosing a grace period is deciding how long people need to enrol,
 * and the settings page could not tell them whether that was everyone or nobody
 * — so "14 days" was a guess. Counted here rather than on a route of its own:
 * it is exactly the context for the policy this endpoint already returns, and it
 * is read by the same `org:settings` admin.
 *
 * ENROLLED = holds a passkey or a CONFIRMED authenticator enrolment, i.e. what
 * `utils/token.ts` will accept at issuance. Password-only accounts are the ones
 * the deadline will refuse.
 *
 * DECLINED is a strict subset of the password-only ones: members who were shown
 * the prompt to protect their own account and chose "don't ask again"
 * (`helpers/mfa-nudge.ts`). It is the difference between "seven people haven't
 * got round to it" and "three of them have decided not to" — the first is a
 * reminder to send, the second is a conversation to have, and an admin who
 * turned the requirement on without knowing which would be surprised by who
 * complained. Counted, never named: this endpoint's job is a number for the
 * grace-period decision, and the org's audit log already carries
 * `user.mfa.prompt_declined` with the actor for anyone who needs the who.
 * Members who declined and then enrolled anyway do not count — enrolment clears
 * the decline, and the `$in` on the un-enrolled ids is a second guard.
 */
export async function mfaEnrolment(orgId: string): Promise<{ members: number; enrolled: number; declined: number }> {
  const { UserTotp, WebAuthnCredential } = await import('../models/index.js');
  const memberships = await UserOrganization
    .find({ organizationId: toOrgId(orgId), isActive: true })
    .select('userId')
    .lean();
  const userIds = memberships.map((m) => m.userId);
  if (userIds.length === 0) return { members: 0, enrolled: 0, declined: 0 };

  const [withPasskey, withTotp] = await Promise.all([
    WebAuthnCredential.distinct('userId', { userId: { $in: userIds } }),
    UserTotp.distinct('userId', { userId: { $in: userIds }, ...ACTIVE_TOTP }),
  ]);
  // A person with BOTH factors is one person; the union is the count.
  const enrolled = new Set([...withPasskey, ...withTotp].map(String));
  const withoutFactor = userIds.filter((id) => !enrolled.has(String(id)));
  const declined = withoutFactor.length === 0
    ? 0
    : await User.countDocuments({ '_id': { $in: withoutFactor }, 'mfaNudge.declinedAt': { $ne: null } });
  return { members: userIds.length, enrolled: enrolled.size, declined };
}

/** The wire shape — dates as ISO strings, and the grace deadline spelled out so
 *  the member-facing banner needs no second call. */
export async function mfaPolicyView(policy: EffectiveMfaPolicy) {
  // Name the parent that imposes the requirement, so the UI needn't resolve an
  // org the admin may not be able to read.
  const inheritedFromName = policy.inheritedFrom ? await getOrgName(policy.inheritedFrom) : undefined;
  const adminActionsInheritedFromName = policy.adminActionsInheritedFrom
    ? await getOrgName(policy.adminActionsInheritedFrom)
    : undefined;
  return {
    requireMfa: policy.requireMfa,
    enforced: policy.enforced,
    own: policy.own,
    idpEnforcesMfa: policy.idpEnforcesMfa,
    ...(policy.graceUntil ? { graceUntil: policy.graceUntil.toISOString() } : {}),
    ...(policy.requiredSince ? { requiredSince: policy.requiredSince.toISOString() } : {}),
    ...(policy.inheritedFrom ? { inheritedFrom: policy.inheritedFrom } : {}),
    ...(inheritedFromName ? { inheritedFromName } : {}),
    adminActionsRequireMfa: policy.adminActionsRequireMfa,
    adminActionsOwn: policy.adminActionsOwn,
    ...(policy.adminActionsInheritedFrom ? { adminActionsInheritedFrom: policy.adminActionsInheritedFrom } : {}),
    ...(adminActionsInheritedFromName ? { adminActionsInheritedFromName } : {}),
    defaultGraceDays: DEFAULT_MFA_GRACE_DAYS,
  };
}


// -- Impersonation policy ----------------------------------------------------------

/** A resolved policy in the stored-document shape, so a partial update can be
 *  laid over it and resolved again. */
export function previousResolvedAsDoc(p: ReturnType<typeof resolveImpersonationPolicy>) {
  return { impersonationPolicy: p.policy, allowSelfApproval: p.allowSelfApproval };
}

/**
 * Whether moving from `from` to `to` WEAKENS the policy: a less strict mode
 * (`IMPERSONATION_POLICIES` is ordered open → consent → denied), or turning
 * self-approval on.
 */
export function isLooseningImpersonation(
  from: ReturnType<typeof resolveImpersonationPolicy>,
  to: ReturnType<typeof resolveImpersonationPolicy>,
): boolean {
  return IMPERSONATION_POLICIES.indexOf(to.policy) < IMPERSONATION_POLICIES.indexOf(from.policy)
    || (to.allowSelfApproval && !from.allowSelfApproval);
}

/** Add the stricter parent's display name next to `inheritedFrom`, so the UI
 *  needn't resolve an org the admin may not be able to read. */
export async function withInheritedFromName<T extends { inheritedFrom?: string }>(policy: T): Promise<T & { inheritedFromName?: string }> {
  const inheritedFromName = policy.inheritedFrom ? await getOrgName(policy.inheritedFrom) : undefined;
  return inheritedFromName ? { ...policy, inheritedFromName } : policy;
}

/** The org's OWN impersonation policy, resolved, or null when the org is gone. */
export async function readImpersonationPolicy(orgId: string): Promise<ReturnType<typeof resolveImpersonationPolicy> | null> {
  const doc = await Organization.findById(toOrgId(orgId)).select('impersonationPolicy allowSelfApproval').lean();
  return doc ? resolveImpersonationPolicy(doc) : null;
}

/** Write the org's own impersonation settings; the resolved result, or null when the org is gone. */
export async function writeImpersonationPolicy(
  orgId: string,
  body: { impersonationPolicy?: string; allowSelfApproval?: boolean },
): Promise<ReturnType<typeof resolveImpersonationPolicy> | null> {
  const updated = await Organization.findByIdAndUpdate(
    toOrgId(orgId),
    { $set: body },
    { new: true, projection: 'impersonationPolicy allowSelfApproval' },
  ).lean();
  return updated ? resolveImpersonationPolicy(updated) : null;
}

// -- Password policy -------------------------------------------------------------

export async function passwordPolicyView(orgId: string) {
  const policy = await resolveEffectivePasswordPolicy(orgId);
  const inheritedFromName = policy.inheritedFrom ? await getOrgName(policy.inheritedFrom) : undefined;
  return {
    minLength: policy.minLength,
    own: policy.own ?? null,
    platformMinLength: policy.platformMinLength,
    maxLength: PASSWORD_MAX_LENGTH,
    ...(policy.inheritedFrom ? { inheritedFrom: policy.inheritedFrom } : {}),
    ...(inheritedFromName ? { inheritedFromName } : {}),
    // Stated, not implied: an org can't measure existing passwords (only hashes
    // are stored), so a raised minimum bites at each member's next password
    // sign-in, where a shorter password must be changed before a session opens.
    enforcement: 'new-passwords-and-next-password-sign-in' as const,
  };
}


/** The org's OWN password minimum (null = the platform floor). */
export async function readOwnPasswordMinLength(orgId: string): Promise<number | null> {
  const doc = await Organization.findById(toOrgId(orgId)).select('passwordMinLength').lean();
  return doc?.passwordMinLength ?? null;
}

/** Set (or, with null, clear) the org's own password minimum. */
export async function writePasswordMinLength(orgId: string, minLength: number | null): Promise<void> {
  await Organization.updateOne(
    { _id: toOrgId(orgId) },
    minLength === null ? { $unset: { passwordMinLength: '' } } : { $set: { passwordMinLength: minLength } },
  );
}

// -- Authenticator (AAGUID) policy ---------------------------------------------

/** A passkey a member holds that the EFFECTIVE policy would not accept. */
interface NonCompliantMember {
  userId: string;
  username: string;
  email: string;
  passkeys: Array<{ id: string; name: string; aaguid: string | null; model: string | null }>;
  /** Also has a confirmed authenticator app, so MFA is still available to them. */
  hasAuthenticatorApp: boolean;
}

function modelName(models: Map<string, MdsModel> | null, aaguid: string | null | undefined): string | null {
  if (!aaguid || !models) return null;
  return models.get(aaguid.toLowerCase())?.description ?? null;
}

/**
 * The org's members measured against an allowlist: which passkey models they
 * use (so an admin can build the list from reality), and who holds ONLY
 * passkeys the list would not accept.
 */
async function memberCompliance(orgId: string, allowed: string[] | null, models: Map<string, MdsModel> | null) {
  // The factor collections load on demand: most policy reads never reach them.
  const { UserTotp, WebAuthnCredential } = await import('../models/index.js');
  const memberships = await UserOrganization.find({ organizationId: toOrgId(orgId), isActive: true }).select('userId').lean();
  const userIds = memberships.map((m) => m.userId);
  const creds = userIds.length === 0
    ? []
    : await WebAuthnCredential.find({ userId: { $in: userIds } }).select('userId name aaguid').lean();

  const inUse = new Map<string, number>();
  const offending = new Map<string, NonCompliantMember['passkeys']>();
  for (const c of creds) {
    const aaguid = c.aaguid ? c.aaguid.toLowerCase() : null;
    if (aaguid) inUse.set(aaguid, (inUse.get(aaguid) ?? 0) + 1);
    if (aaguidPermitted({ allowed }, aaguid ?? undefined)) continue;
    const key = String(c.userId);
    const list = offending.get(key) ?? [];
    list.push({ id: String(c._id), name: c.name, aaguid, model: modelName(models, aaguid) });
    offending.set(key, list);
  }

  let nonCompliant: NonCompliantMember[] = [];
  if (offending.size > 0) {
    const ids = [...offending.keys()];
    const [people, withTotp] = await Promise.all([
      User.find({ _id: { $in: ids } }).select('username email').lean(),
      UserTotp.distinct('userId', { userId: { $in: ids }, ...ACTIVE_TOTP }),
    ]);
    const totpSet = new Set(withTotp.map(String));
    nonCompliant = people.map((p) => ({
      userId: String(p._id),
      username: p.username,
      email: p.email,
      passkeys: offending.get(String(p._id)) ?? [],
      hasAuthenticatorApp: totpSet.has(String(p._id)),
    })).sort((a, b) => a.email.localeCompare(b.email));
  }

  return {
    members: userIds.length,
    passkeys: creds.length,
    modelsInUse: [...inUse.entries()]
      .map(([aaguid, count]) => ({ aaguid, count, model: modelName(models, aaguid) }))
      .sort((a, b) => b.count - a.count),
    nonCompliant,
  };
}

export async function authenticatorPolicyView(orgId: string) {
  const [policy, catalog] = await Promise.all([resolveEffectiveAuthenticatorPolicy(orgId), listModels()]);
  const models = catalog ? new Map(catalog.map((m) => [m.aaguid, m])) : null;
  const inheritedFromNames = await Promise.all(policy.inheritedFrom.map(async (oid) => ({ id: oid, name: (await getOrgName(oid)) ?? oid })));
  const named = (list: string[]) => list.map((aaguid) => ({ aaguid, model: modelName(models, aaguid) }));
  return {
    own: named(policy.own.map((a) => a.toLowerCase())),
    effective: policy.allowed === null ? null : named(policy.allowed),
    inheritedFrom: inheritedFromNames,
    // The MDS catalog for the editor's picker. Unavailable (null) when no
    // metadata is configured/loadable — the editor then takes raw AAGUIDs, and
    // registrations under a list are refused until metadata loads.
    mds: {
      available: catalog !== null,
      models: catalog ? catalog.filter((m) => !m.compromised).map((m) => ({ aaguid: m.aaguid, model: m.description })) : [],
    },
    compliance: await memberCompliance(orgId, policy.allowed, models),
  };
}

/** The org's OWN authenticator allowlist, lowercased (empty = no list). */
export async function readOwnAaguids(orgId: string): Promise<string[]> {
  const doc = await Organization.findById(toOrgId(orgId)).select('allowedAuthenticatorAaguids').lean();
  return (doc?.allowedAuthenticatorAaguids ?? []).map((v) => v.toLowerCase());
}

/**
 * The allowlist that would GOVERN `orgId` if its own list became `next`:
 * combined with every ancestor's (lineage strictness — a team can narrow what
 * its parents accept, never widen it).
 */
export async function effectiveAllowlistWith(orgId: string, next: string[]): Promise<string[] | null> {
  const lineage = await readOrgPolicyLineage<{ allowedAuthenticatorAaguids?: string[] }>(orgId, 'allowedAuthenticatorAaguids');
  return combineAllowlists([next, ...lineage.slice(1).map((d) => d.allowedAuthenticatorAaguids)]);
}

/**
 * Whether the CALLER keeps a way to reach `aal: 2` in this org under
 * `allowed`: a confirmed authenticator app, or a passkey the list accepts.
 */
export async function callerKeepsAFactor(userId: string, allowed: string[] | null): Promise<boolean> {
  const { WebAuthnCredential } = await import('../models/index.js');
  if (allowed === null) return true;
  if (await hasActiveTotp(userId)) return true;
  const creds = await WebAuthnCredential.find({ userId }).select('aaguid').lean();
  return creds.some((c) => aaguidPermitted({ allowed }, c.aaguid));
}

/** Set (or, when empty, clear) the org's own authenticator allowlist. */
export async function writeAaguids(orgId: string, next: string[]): Promise<void> {
  await Organization.updateOne(
    { _id: toOrgId(orgId) },
    next.length === 0 ? { $unset: { allowedAuthenticatorAaguids: '' } } : { $set: { allowedAuthenticatorAaguids: next } },
  );
}
