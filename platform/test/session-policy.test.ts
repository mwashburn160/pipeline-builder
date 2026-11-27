// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Interactive-session lifetime policy (helpers/session-policy.ts): the platform
 * ceiling, an org's own (tighten-only) values, strictest-wins down the org tree,
 * and the expiry arithmetic every refresh applies.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

let lineage: Array<Record<string, unknown>> | Error = [];
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { session: { maxAgeDays: 30, idleTimeoutMinutes: 15 } } } }));
jest.unstable_mockModule('../src/helpers/org-policy-lineage.js', () => ({
  readOrgPolicyLineage: async () => {
    if (lineage instanceof Error) throw lineage;
    return lineage;
  },
}));

const {
  interactiveSessionEnd, interactiveSessionEndReason, interactiveSessionExpired, platformSessionLimits, resolveEffectiveSessionPolicy, sessionLimitsFor,
} = await import('../src/helpers/session-policy.js');

const DAY = 86400_000;
const MINUTE = 60_000;

beforeEach(() => {
  lineage = [];
});

describe('platformSessionLimits', () => {
  it('reads the env-configured ceiling (idle timeout in MINUTES)', () => {
    expect(platformSessionLimits()).toEqual({ maxAgeDays: 30, idleTimeoutMinutes: 15 });
  });
});

describe('resolveEffectiveSessionPolicy', () => {
  it('an org with no policy gets the platform ceiling', async () => {
    lineage = [{ _id: 'org-1' }];
    await expect(resolveEffectiveSessionPolicy('org-1')).resolves.toEqual({
      maxAgeDays: 30, idleTimeoutMinutes: 15, own: {}, platform: { maxAgeDays: 30, idleTimeoutMinutes: 15 },
    });
  });

  it('an org may only TIGHTEN: a looser own value leaves the platform bound in force', async () => {
    lineage = [{ _id: 'org-1', sessionPolicy: { maxAgeDays: 90, idleTimeoutMinutes: 600 } }];
    const p = await resolveEffectiveSessionPolicy('org-1');
    expect(p).toMatchObject({ maxAgeDays: 30, idleTimeoutMinutes: 15, own: { maxAgeDays: 90, idleTimeoutMinutes: 600 } });
  });

  it('a shorter own idle timeout shortens the ceiling', async () => {
    lineage = [{ _id: 'org-1', sessionPolicy: { idleTimeoutMinutes: 10 } }];
    await expect(resolveEffectiveSessionPolicy('org-1')).resolves.toMatchObject({ idleTimeoutMinutes: 10, own: { idleTimeoutMinutes: 10 } });
  });

  it('the strictest ancestor wins, per field, and is named', async () => {
    lineage = [
      { _id: 'team', sessionPolicy: { maxAgeDays: 10 } },
      { _id: 'mid', sessionPolicy: { idleTimeoutMinutes: 6 } },
      { _id: 'root', sessionPolicy: { maxAgeDays: 5, idleTimeoutMinutes: 8 } },
    ];
    const p = await resolveEffectiveSessionPolicy('team');
    expect(p).toMatchObject({ maxAgeDays: 5, maxAgeInheritedFrom: 'root', idleTimeoutMinutes: 6, idleTimeoutInheritedFrom: 'mid' });
  });

  it('ignores a malformed stored value (and the removed days field)', async () => {
    lineage = [{ _id: 'org-1', sessionPolicy: { maxAgeDays: 0, idleTimeoutMinutes: 'x', idleTimeoutDays: 1 } }];
    const p = await resolveEffectiveSessionPolicy('org-1');
    expect(p).toMatchObject({ maxAgeDays: 30, idleTimeoutMinutes: 15, own: {} });
    expect(p).not.toHaveProperty('idleTimeoutDays');
  });

  it('fails OPEN to the platform ceiling on a read error', async () => {
    lineage = new Error('mongo down');
    await expect(resolveEffectiveSessionPolicy('org-1')).resolves.toMatchObject({ maxAgeDays: 30, idleTimeoutMinutes: 15 });
  });
});

describe('sessionLimitsFor', () => {
  it('is the platform ceiling with no org', async () => {
    await expect(sessionLimitsFor([undefined])).resolves.toEqual({ maxAgeDays: 30, idleTimeoutMinutes: 15 });
  });

  it('is the strictest across the given orgs', async () => {
    lineage = [{ _id: 'o', sessionPolicy: { maxAgeDays: 12, idleTimeoutMinutes: 7 } }];
    await expect(sessionLimitsFor(['o', 'o'])).resolves.toEqual({ maxAgeDays: 12, idleTimeoutMinutes: 7 });
  });
});

describe('interactive session expiry', () => {
  const limits = { maxAgeDays: 30, idleTimeoutMinutes: 15 };
  const now = new Date('2026-06-01T00:00:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const minsAgo = (m: number) => new Date(now.getTime() - m * MINUTE);

  it('computes both bounds; the idle bound counts from lastActiveAt', () => {
    const end = interactiveSessionEnd({ authTime: ago(10), lastActiveAt: minsAgo(3) }, limits);
    expect(end.absoluteEnd.getTime()).toBe(ago(10).getTime() + 30 * DAY);
    expect(end.idleEnd.getTime()).toBe(minsAgo(3).getTime() + 15 * MINUTE);
  });

  it.each([
    ['inside both bounds', 10, 14, false],
    ['idle past the timeout', 10, 16, true],
    ['past the maximum age however active', 31, 0, true],
    ['exactly at the idle bound', 7, 15, true],
  ])('%s', (_label, signedInDays, idleMinutes, expired) => {
    expect(interactiveSessionExpired({ authTime: ago(signedInDays), lastActiveAt: minsAgo(idleMinutes) }, limits, now)).toBe(expired);
  });

  it('names WHICH bound ended it', () => {
    expect(interactiveSessionEndReason({ authTime: ago(1), lastActiveAt: minsAgo(20) }, limits, now)).toBe('idle');
    expect(interactiveSessionEndReason({ authTime: ago(31), lastActiveAt: minsAgo(1) }, limits, now)).toBe('max-age');
    expect(interactiveSessionEndReason({ authTime: ago(1), lastActiveAt: minsAgo(1) }, limits, now)).toBeNull();
  });
});
