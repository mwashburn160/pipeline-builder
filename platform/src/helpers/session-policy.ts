// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Session lifetime policy for INTERACTIVE refresh-session slots (signed-in
 * devices and the CLI sessions a browser approves).
 *
 * Two bounds, both checked whenever a slot is renewed or switched:
 *   - MAXIMUM AGE — counted from the sign-in that opened the slot (`authTime`,
 *     which renewal never resets). Past it the person signs in again, however
 *     active the session has been.
 *   - IDLE TIMEOUT — counted from the slot's last use (`lastUsedAt`: refresh,
 *     switch-org). A device left untouched that long is signed out.
 *
 * The PLATFORM sets the ceiling (`SESSION_MAX_AGE_DAYS`, default 30;
 * `SESSION_IDLE_TIMEOUT_DAYS`, default 7). An org may only TIGHTEN it
 * (`Organization.sessionPolicy`), and — like the password policy — the
 * strictest value across the org and its ancestors wins, so a parent account
 * can shorten sessions for every team beneath it. The policy that applies to a
 * slot is the one of the org its tokens are minted for (the slot's
 * `activeOrgId`; on switch-org, also the destination).
 *
 * MACHINE slots are out of scope on purpose: they renew unattended (no idle
 * timeout could ever be met) and carry their own fixed end (`expiresAt`).
 */

import { readOrgPolicyLineage } from './org-policy-lineage.js';
import { config } from '../config/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The platform defaults (`SESSION_MAX_AGE_DAYS` / `SESSION_IDLE_TIMEOUT_DAYS` unset). */
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_IDLE_TIMEOUT_DAYS = 7;

/** Upper bound an org may store for either field (days). */
export const SESSION_POLICY_MAX_DAYS = 365;

/** The two lifetime bounds, in days. */
export interface SessionLimits {
  maxAgeDays: number;
  idleTimeoutDays: number;
}

/** An org's OWN stored policy (either field absent = not set by this org). */
export interface OrgSessionPolicy {
  maxAgeDays?: number;
  idleTimeoutDays?: number;
}

/** The platform ceiling (env-configured). */
export function platformSessionLimits(): SessionLimits {
  const session = config.auth.session as Partial<SessionLimits> | undefined;
  return {
    maxAgeDays: session?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
    idleTimeoutDays: session?.idleTimeoutDays ?? DEFAULT_IDLE_TIMEOUT_DAYS,
  };
}

/** The resolved policy for one org. */
export interface EffectiveSessionPolicy extends SessionLimits {
  /** This org's own stored values. */
  own: OrgSessionPolicy;
  /** The ancestor whose (stricter) value is in force, per field, when not this org's. */
  maxAgeInheritedFrom?: string;
  idleTimeoutInheritedFrom?: string;
  /** The platform ceiling, so a UI can show where the scale ends. */
  platform: SessionLimits;
}

function validDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Resolve the effective session policy for `orgId`: min(platform, the org's own
 * value, every ancestor's), per field. Fails OPEN to the platform ceiling on a
 * read error — the same trade the password and MFA policies make: a database
 * blip must not sign every session out, and the platform bound still applies.
 */
export async function resolveEffectiveSessionPolicy(orgId: string): Promise<EffectiveSessionPolicy> {
  const platform = platformSessionLimits();
  let docs: Array<{ _id: string; sessionPolicy?: OrgSessionPolicy }> = [];
  try {
    docs = await readOrgPolicyLineage<{ sessionPolicy?: OrgSessionPolicy }>(orgId, 'sessionPolicy');
  } catch {
    return { ...platform, own: {}, platform };
  }
  const ownDoc = docs[0]?.sessionPolicy ?? {};
  const own: OrgSessionPolicy = {
    ...(validDays(ownDoc.maxAgeDays) ? { maxAgeDays: ownDoc.maxAgeDays } : {}),
    ...(validDays(ownDoc.idleTimeoutDays) ? { idleTimeoutDays: ownDoc.idleTimeoutDays } : {}),
  };
  let maxAgeDays = Math.min(platform.maxAgeDays, own.maxAgeDays ?? Infinity);
  let idleTimeoutDays = Math.min(platform.idleTimeoutDays, own.idleTimeoutDays ?? Infinity);
  let maxAgeInheritedFrom: string | undefined;
  let idleTimeoutInheritedFrom: string | undefined;
  for (const doc of docs.slice(1)) {
    const p = doc.sessionPolicy;
    if (validDays(p?.maxAgeDays) && p.maxAgeDays < maxAgeDays) {
      maxAgeDays = p.maxAgeDays;
      maxAgeInheritedFrom = doc._id;
    }
    if (validDays(p?.idleTimeoutDays) && p.idleTimeoutDays < idleTimeoutDays) {
      idleTimeoutDays = p.idleTimeoutDays;
      idleTimeoutInheritedFrom = doc._id;
    }
  }
  return {
    maxAgeDays,
    idleTimeoutDays,
    own,
    ...(maxAgeInheritedFrom ? { maxAgeInheritedFrom } : {}),
    ...(idleTimeoutInheritedFrom ? { idleTimeoutInheritedFrom } : {}),
    platform,
  };
}

/**
 * The bounds that govern a slot whose tokens are minted for any of `orgIds`:
 * the strictest of the platform ceiling and each org's effective policy.
 */
export async function sessionLimitsFor(orgIds: ReadonlyArray<string | undefined>): Promise<SessionLimits> {
  let limits = platformSessionLimits();
  for (const orgId of new Set(orgIds.filter((o): o is string => !!o))) {
    const policy = await resolveEffectiveSessionPolicy(orgId);
    limits = {
      maxAgeDays: Math.min(limits.maxAgeDays, policy.maxAgeDays),
      idleTimeoutDays: Math.min(limits.idleTimeoutDays, policy.idleTimeoutDays),
    };
  }
  return limits;
}

/** When an interactive slot ends under `limits`: the earlier of its two bounds. */
export interface InteractiveSessionEnd {
  /** `authTime` + maximum age — fixed for the slot's life. */
  absoluteEnd: Date;
  /** `lastUsedAt` + idle timeout — moves with every use. */
  idleEnd: Date;
}

export function interactiveSessionEnd(
  slot: { authTime: Date | string; lastUsedAt: Date | string },
  limits: SessionLimits,
): InteractiveSessionEnd {
  return {
    absoluteEnd: new Date(new Date(slot.authTime).getTime() + limits.maxAgeDays * DAY_MS),
    idleEnd: new Date(new Date(slot.lastUsedAt).getTime() + limits.idleTimeoutDays * DAY_MS),
  };
}

/** Whether an interactive slot is past either bound at `now`. */
export function interactiveSessionExpired(
  slot: { authTime: Date | string; lastUsedAt: Date | string },
  limits: SessionLimits,
  now: Date = new Date(),
): boolean {
  const { absoluteEnd, idleEnd } = interactiveSessionEnd(slot, limits);
  return Math.min(absoluteEnd.getTime(), idleEnd.getTime()) <= now.getTime();
}
