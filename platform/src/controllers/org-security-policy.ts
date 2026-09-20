// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An organization's password policy and authenticator (passkey model) policy —
 * read and update.
 *
 *   GET   /organization/:id/password-policy
 *   PATCH /organization/:id/password-policy
 *   GET   /organization/:id/authenticator-policy
 *   PATCH /organization/:id/authenticator-policy
 *
 * Gated on `org:settings` (+ step-up for the writes) at the route and on
 * `canAdministerOrg` here — the same tenancy rule as the MFA policy, so an
 * admin of a parent org may set them for a team beneath it. LOOSENING either
 * (a lower minimum, clearing or widening the allowlist) additionally needs an
 * `aal: 2` session, exactly as loosening the MFA policy does; tightening stays
 * open to a single-factor admin.
 *
 * Enforcement lives elsewhere: `helpers/password-policy.ts` (every
 * password-setting path, and password sign-in) and
 * `helpers/authenticator-policy.ts` + `services/webauthn-service.ts`
 * (registration) + `utils/token.ts` (issuance).
 */

import { createLogger, getParam, refuseWeakSession, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import {
  aaguidPermitted,
  combineAllowlists,
  normalizeAaguid,
  resolveEffectiveAuthenticatorPolicy,
} from '../helpers/authenticator-policy.js';
import { canAdministerOrg, requireAuth, withController } from '../helpers/controller-helper.js';
import { resolveEffectiveMfaPolicy } from '../helpers/mfa-policy.js';
import { getOrgName } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import { readOrgPolicyLineage } from '../helpers/org-policy-lineage.js';
import { PASSWORD_MAX_LENGTH, resolveEffectivePasswordPolicy } from '../helpers/password-policy.js';
import { Organization, User, UserOrganization, UserTotp, WebAuthnCredential } from '../models/index.js';
import { incCounter } from '../observability/metrics.js';
import { listModels, type MdsModel } from '../services/fido-mds.js';
import { updateAuthenticatorPolicySchema, updatePasswordPolicySchema, validateBody } from '../utils/validation.js';

const logger = createLogger('org-security-policy');

/** Shared front half: authenticated, administers the org, org exists. */
async function administeredOrgId(
  req: Parameters<Parameters<typeof withController>[1]>[0],
  res: Parameters<Parameters<typeof withController>[1]>[1],
  verb: 'view' | 'change',
): Promise<string | null> {
  if (!requireAuth(req, res)) return null;
  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) {
    sendError(res, 403, `You can only ${verb} the policy of an organization you administer`);
    return null;
  }
  if (!(await Organization.exists({ _id: toOrgId(id) }))) {
    sendError(res, 404, 'Organization not found');
    return null;
  }
  return id;
}

// -- Password policy ------------------------------------------------------------

async function passwordView(orgId: string) {
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

export const getPasswordPolicy = withController('Get password policy', async (req, res) => {
  const id = await administeredOrgId(req, res, 'view');
  if (!id) return;
  sendSuccess(res, 200, await passwordView(id));
});

export const updatePasswordPolicy = withController('Update password policy', async (req, res) => {
  const id = await administeredOrgId(req, res, 'change');
  if (!id) return;
  const body = validateBody(updatePasswordPolicySchema, req.body, res);
  if (!body) return;

  const before = await Organization.findById(toOrgId(id)).select('passwordMinLength').lean() as { passwordMinLength?: number } | null;
  const from = before?.passwordMinLength ?? null;
  const to = body.minLength;
  // Lowering (or clearing) the minimum weakens the org's protection.
  const loosening = from !== null && (to === null || to < from);
  if (loosening && refuseWeakSession(req, res, { minAssurance: 2 })) return;

  await Organization.updateOne(
    { _id: toOrgId(id) },
    to === null ? { $unset: { passwordMinLength: '' } } : { $set: { passwordMinLength: to } },
  );

  audit(req, 'org.password_policy.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: { minLength: { from, to } },
  });
  incCounter('platform_password_policy_changes_total');
  logger.info('Password policy updated', { orgId: id, by: req.user!.sub, from, to });
  sendSuccess(res, 200, await passwordView(id), 'Password policy updated');
});

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
  const memberships = await UserOrganization.find({ organizationId: toOrgId(orgId), isActive: true }).select('userId').lean();
  const userIds = memberships.map((m) => m.userId);
  const creds = userIds.length === 0
    ? []
    : await WebAuthnCredential.find({ userId: { $in: userIds } }).select('userId name aaguid').lean() as Array<{
      _id: unknown; userId: unknown; name: string; aaguid?: string;
    }>;

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
      UserTotp.distinct('userId', { userId: { $in: ids }, activatedAt: { $ne: null } }),
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

async function authenticatorView(orgId: string) {
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

export const getAuthenticatorPolicy = withController('Get authenticator policy', async (req, res) => {
  const id = await administeredOrgId(req, res, 'view');
  if (!id) return;
  sendSuccess(res, 200, await authenticatorView(id));
});

/**
 * Whether the CALLER keeps a way to reach `aal: 2` in this org under
 * `allowed`: a confirmed authenticator app, or a passkey the list accepts.
 */
async function callerKeepsAFactor(userId: string, allowed: string[] | null): Promise<boolean> {
  if (allowed === null) return true;
  if (await UserTotp.exists({ userId, activatedAt: { $ne: null } })) return true;
  const creds = await WebAuthnCredential.find({ userId }).select('aaguid').lean() as Array<{ aaguid?: string }>;
  return creds.some((c) => aaguidPermitted({ allowed }, c.aaguid));
}

export const updateAuthenticatorPolicy = withController('Update authenticator policy', async (req, res) => {
  const id = await administeredOrgId(req, res, 'change');
  if (!id) return;
  const body = validateBody(updateAuthenticatorPolicySchema, req.body, res);
  if (!body) return;

  const invalid = body.allowedAaguids.filter((v) => normalizeAaguid(v) === null);
  if (invalid.length > 0) {
    return sendError(res, 400, `Not a valid authenticator AAGUID: ${invalid.join(', ')}`, 'INVALID_AAGUID', { invalid });
  }
  const next = [...new Set(body.allowedAaguids.map((v) => normalizeAaguid(v)!))];

  const before = await Organization.findById(toOrgId(id)).select('allowedAuthenticatorAaguids').lean() as { allowedAuthenticatorAaguids?: string[] } | null;
  const prev = (before?.allowedAuthenticatorAaguids ?? []).map((v) => v.toLowerCase());
  // Clearing the list, or adding a model to an existing one, WIDENS what counts
  // as a trusted passkey — a weakening, like lowering the password minimum.
  const loosening = prev.length > 0 && (next.length === 0 || next.some((v) => !prev.includes(v)));
  if (loosening && refuseWeakSession(req, res, { minAssurance: 2 })) return;

  // REFUSE THE LOCKOUT. Where the org enforces MFA, an admin whose only factor
  // is a passkey the NEW list rejects would drop to `aal: 1` here — and be
  // refused at their next sign-in, unable to fix the list. They add their own
  // model (or an authenticator app) first.
  if (next.length > 0) {
    const lineage = await readOrgPolicyLineage<{ allowedAuthenticatorAaguids?: string[] }>(id, 'allowedAuthenticatorAaguids');
    const effectiveNext = combineAllowlists([next, ...lineage.slice(1).map((d) => d.allowedAuthenticatorAaguids)]);
    const mfa = await resolveEffectiveMfaPolicy(id);
    if (mfa.enforced && !(await callerKeepsAFactor(req.user!.sub, effectiveNext))) {
      return sendError(
        res, 409,
        'This list would leave you without an accepted second factor in an organization that requires MFA. '
          + 'Add the model of one of your own passkeys, or enrol an authenticator app, first.',
        'AUTHENTICATOR_POLICY_LOCKOUT',
      );
    }
  }

  await Organization.updateOne(
    { _id: toOrgId(id) },
    next.length === 0 ? { $unset: { allowedAuthenticatorAaguids: '' } } : { $set: { allowedAuthenticatorAaguids: next } },
  );

  audit(req, 'org.authenticator_policy.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: {
      added: next.filter((v) => !prev.includes(v)),
      removed: prev.filter((v) => !next.includes(v)),
      count: { from: prev.length, to: next.length },
    },
  });
  incCounter('platform_authenticator_policy_changes_total');
  logger.info('Authenticator policy updated', { orgId: id, by: req.user!.sub, from: prev.length, to: next.length });
  sendSuccess(res, 200, await authenticatorView(id), 'Authenticator policy updated');
});
