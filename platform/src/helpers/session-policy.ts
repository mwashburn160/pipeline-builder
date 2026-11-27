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
 *   - IDLE TIMEOUT — counted from the slot's last real ACTIVITY
 *     (`lastActiveAt`): a refresh the client marks `activity: 'user'` (there
 *     was real input since its last refresh), or a switch-org. A PASSIVE
 *     refresh — a background poll of an unattended tab — renews the token but
 *     never moves this clock, so an open tab nobody touches still times out.
 *
 * The PLATFORM sets the ceiling (`SESSION_MAX_AGE_DAYS`, default 30;
 * `SESSION_IDLE_TIMEOUT_MINUTES`, default 15, minimum 5). An org may only TIGHTEN it
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
const MINUTE_MS = 60 * 1000;

/** The platform defaults (`SESSION_MAX_AGE_DAYS` / `SESSION_IDLE_TIMEOUT_MINUTES` unset). */
const DEFAULT_MAX_AGE_DAYS = 30;
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 15;

/** Upper bound an org may store for the maximum age (days). */
export const SESSION_POLICY_MAX_DAYS = 365;

/** The shortest idle timeout anything may set (minutes) — platform and org alike. */
export const SESSION_IDLE_TIMEOUT_MIN_MINUTES = 5;

/** The two lifetime bounds: maximum age in days, idle timeout in minutes. */
export interface SessionLimits {
  maxAgeDays: number;
  idleTimeoutMinutes: number;
}

/** An org's OWN stored policy (either field absent = not set by this org). */
export interface OrgSessionPolicy {
  maxAgeDays?: number;
  idleTimeoutMinutes?: number;
}

/** The platform ceiling (env-configured). */
export function platformSessionLimits(): SessionLimits {
  const session = config.auth.session as Partial<SessionLimits> | undefined;
  return {
    maxAgeDays: session?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
    idleTimeoutMinutes: session?.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES,
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

function validBound(value: unknown): value is number {
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
    ...(validBound(ownDoc.maxAgeDays) ? { maxAgeDays: ownDoc.maxAgeDays } : {}),
    ...(validBound(ownDoc.idleTimeoutMinutes) ? { idleTimeoutMinutes: ownDoc.idleTimeoutMinutes } : {}),
  };
  let maxAgeDays = Math.min(platform.maxAgeDays, own.maxAgeDays ?? Infinity);
  let idleTimeoutMinutes = Math.min(platform.idleTimeoutMinutes, own.idleTimeoutMinutes ?? Infinity);
  let maxAgeInheritedFrom: string | undefined;
  let idleTimeoutInheritedFrom: string | undefined;
  for (const doc of docs.slice(1)) {
    const p = doc.sessionPolicy;
    if (validBound(p?.maxAgeDays) && p.maxAgeDays < maxAgeDays) {
      maxAgeDays = p.maxAgeDays;
      maxAgeInheritedFrom = doc._id;
    }
    if (validBound(p?.idleTimeoutMinutes) && p.idleTimeoutMinutes < idleTimeoutMinutes) {
      idleTimeoutMinutes = p.idleTimeoutMinutes;
      idleTimeoutInheritedFrom = doc._id;
    }
  }
  return {
    maxAgeDays,
    idleTimeoutMinutes,
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
      idleTimeoutMinutes: Math.min(limits.idleTimeoutMinutes, policy.idleTimeoutMinutes),
    };
  }
  return limits;
}

/** The lifetime inputs of an interactive slot. */
export interface InteractiveLifetime {
  /** The sign-in that opened it — the maximum age counts from here. */
  authTime: Date | string;
  /** Its last real activity — the idle timeout counts from here. */
  lastActiveAt: Date | string;
}

/** When an interactive slot ends under `limits`: the earlier of its two bounds. */
export interface InteractiveSessionEnd {
  /** `authTime` + maximum age — fixed for the slot's life. */
  absoluteEnd: Date;
  /** `lastActiveAt` + idle timeout — moves only with real activity. */
  idleEnd: Date;
}

export function interactiveSessionEnd(slot: InteractiveLifetime, limits: SessionLimits): InteractiveSessionEnd {
  return {
    absoluteEnd: new Date(new Date(slot.authTime).getTime() + limits.maxAgeDays * DAY_MS),
    idleEnd: new Date(new Date(slot.lastActiveAt).getTime() + limits.idleTimeoutMinutes * MINUTE_MS),
  };
}

/** Which bound an interactive slot is past at `now` (`max-age` wins a tie), or `null` while it is inside both. */
export function interactiveSessionEndReason(
  slot: InteractiveLifetime,
  limits: SessionLimits,
  now: Date = new Date(),
): 'max-age' | 'idle' | null {
  const { absoluteEnd, idleEnd } = interactiveSessionEnd(slot, limits);
  if (absoluteEnd.getTime() <= now.getTime()) return 'max-age';
  if (idleEnd.getTime() <= now.getTime()) return 'idle';
  return null;
}

/** Whether an interactive slot is past either bound at `now`. */
export function interactiveSessionExpired(
  slot: InteractiveLifetime,
  limits: SessionLimits,
  now: Date = new Date(),
): boolean {
  return interactiveSessionEndReason(slot, limits, now) !== null;
}
