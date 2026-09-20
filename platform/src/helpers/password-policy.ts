// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org password policy + the one check every password-SETTING path runs.
 *
 * WHAT AN ORG CAN SET. A minimum length at or above the platform minimum
 * (`PASSWORD_MIN_LENGTH`) and at most {@link PASSWORD_MAX_LENGTH}. The
 * complexity rules (upper/lower/digit, `models/user.ts`) are platform-wide and
 * not negotiable per org.
 *
 * INHERITANCE mirrors the MFA policy: the STRICTEST value across the org and its
 * ancestors wins, so a parent account can raise the bar for every team and a
 * team can only raise it further.
 *
 * WHO IT APPLIES TO. A person can belong to several orgs; a password is ONE
 * credential for all of them, so the bar for a new password is the strictest
 * effective policy among every org they are an active member of (plus, at
 * registration through an invitation, the inviting org).
 *
 * NOT RETROACTIVE. Only a bcrypt hash is stored, so an existing password can't
 * be measured. The honest check happens at PASSWORD SIGN-IN, the one moment the
 * plaintext is in hand: a password below the person's policy opens no session
 * until it is changed (see `services/password-change-challenge.ts`).
 */

import { readOrgPolicyLineage } from './org-policy-lineage.js';
import { config } from '../config/index.js';
import { PASSWORD_MAX_LENGTH } from '../models/user.js';
import { checkPasswordBreach } from '../services/password-breach.js';

export { PASSWORD_MAX_LENGTH };

/** The platform-wide floor every org minimum sits on. */
export function platformPasswordMinLength(): number {
  return config.auth.passwordMinLength;
}

/** The resolved policy for one org. */
export interface EffectivePasswordPolicy {
  /** The minimum length that applies to this org's members (≥ the platform floor). */
  minLength: number;
  /** This org's OWN stored minimum, when it set one. */
  own?: number;
  /** The ancestor whose (stricter) minimum is in force, when not this org's. */
  inheritedFrom?: string;
  /** The platform floor, so a UI can show where the scale starts. */
  platformMinLength: number;
}

/**
 * Resolve the effective password policy for `orgId` (strictest across the org
 * and its ancestors). Fails OPEN to the platform floor on a read error — the
 * same trade the MFA policy makes: a transient blip must not refuse every
 * password change, and the floor still applies.
 */
export async function resolveEffectivePasswordPolicy(orgId: string): Promise<EffectivePasswordPolicy> {
  const floor = platformPasswordMinLength();
  let docs: Array<{ _id: string; passwordMinLength?: number }> = [];
  try {
    docs = await readOrgPolicyLineage<{ passwordMinLength?: number }>(orgId, 'passwordMinLength');
  } catch {
    return { minLength: floor, platformMinLength: floor };
  }
  const own = typeof docs[0]?.passwordMinLength === 'number' ? docs[0].passwordMinLength : undefined;
  let minLength = Math.max(floor, own ?? floor);
  let inheritedFrom: string | undefined;
  for (const doc of docs.slice(1)) {
    const value = doc.passwordMinLength;
    if (typeof value === 'number' && value > minLength) {
      minLength = value;
      inheritedFrom = doc._id;
    }
  }
  return {
    minLength: Math.min(minLength, PASSWORD_MAX_LENGTH),
    ...(own !== undefined ? { own } : {}),
    ...(inheritedFrom ? { inheritedFrom } : {}),
    platformMinLength: floor,
  };
}

/** The bar a person's NEW password must clear, and which org sets it. */
export interface PersonPasswordPolicy {
  minLength: number;
  /** The org whose (effective) policy is the strictest, when above the floor. */
  orgId?: string;
}

/**
 * The strictest effective policy across every org `userId` is an active member
 * of, plus any `extraOrgIds` (the inviting org at registration). The platform
 * floor when none of them sets anything higher.
 */
export async function passwordPolicyForPerson(
  userId: string | undefined,
  extraOrgIds: readonly string[] = [],
): Promise<PersonPasswordPolicy> {
  const orgIds = new Set(extraOrgIds.filter(Boolean));
  if (userId) {
    const { UserOrganization } = await import('../models/index.js');
    const memberships = await UserOrganization.find({ userId, isActive: true }).select('organizationId').lean();
    for (const m of memberships) orgIds.add(String(m.organizationId));
  }
  let best: PersonPasswordPolicy = { minLength: platformPasswordMinLength() };
  for (const orgId of orgIds) {
    const policy = await resolveEffectivePasswordPolicy(orgId);
    if (policy.minLength > best.minLength) best = { minLength: policy.minLength, orgId };
  }
  return best;
}

/**
 * A refused password, shaped so `handleControllerError` answers it as a 400
 * with its own message and code (its `name` ends in `ServiceError`).
 */
export class PasswordPolicyServiceError extends Error {
  readonly name = 'PasswordPolicyServiceError';
  readonly statusCode = 400;
  constructor(readonly code: 'PASSWORD_TOO_SHORT_FOR_ORG' | 'PASSWORD_BREACHED', message: string) {
    super(message);
  }
}

/**
 * The check EVERY path that sets a password runs (registration, change, admin
 * reset, the sign-in forced change), on top of the platform rules the request
 * schema and the model hook already enforce:
 *   1. the org policy — the strictest minimum among the person's orgs (and the
 *      inviting org, at registration);
 *   2. the breached-password check (fail-open; see `password-breach.ts`).
 * Throws {@link PasswordPolicyServiceError}; resolves when the password is fine.
 */
export async function assertNewPasswordAcceptable(
  password: string,
  subject: { userId?: string; extraOrgIds?: readonly string[] },
): Promise<void> {
  const policy = await passwordPolicyForPerson(subject.userId, subject.extraOrgIds);
  if (password.length < policy.minLength) {
    throw new PasswordPolicyServiceError(
      'PASSWORD_TOO_SHORT_FOR_ORG',
      `Your organization requires passwords of at least ${policy.minLength} characters`,
    );
  }
  const breach = await checkPasswordBreach(password);
  if (breach.outcome === 'breached') {
    throw new PasswordPolicyServiceError(
      'PASSWORD_BREACHED',
      'This password has appeared in a known data breach. Choose a different one.',
    );
  }
}

/**
 * Whether an EXISTING password (plaintext in hand at sign-in) still clears the
 * person's policy — the same strictest-across-their-orgs bar a new password
 * must clear, because it is one credential for all of them. Null when it does;
 * otherwise the policy it misses.
 */
export async function passwordShortfall(password: string, userId: string): Promise<PersonPasswordPolicy | null> {
  const policy = await passwordPolicyForPerson(userId);
  return password.length < policy.minLength ? policy : null;
}

/**
 * The org a REGISTRATION is joining by invitation: the invitation must be
 * pending, unexpired and addressed to the registering email. Anything else
 * yields `undefined` — the later accept step refuses a bad token itself, and
 * the registration simply answers to the platform floor.
 */
export async function invitationOrgForRegistration(token: string, email: string): Promise<string | undefined> {
  const { Invitation } = await import('../models/index.js');
  const invitation = await Invitation.findOne({ token, status: 'pending' })
    .select('organizationId email expiresAt').lean() as { organizationId?: unknown; email?: string; expiresAt?: Date } | null;
  if (!invitation?.organizationId) return undefined;
  if ((invitation.email ?? '').toLowerCase() !== email.trim().toLowerCase()) return undefined;
  if (invitation.expiresAt && new Date(invitation.expiresAt).getTime() <= Date.now()) return undefined;
  return String(invitation.organizationId);
}
