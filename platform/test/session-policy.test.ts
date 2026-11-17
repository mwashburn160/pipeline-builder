// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Interactive-session lifetime policy (helpers/session-policy.ts): the platform
 * ceiling, an org's own (tighten-only) values, strictest-wins down the org tree,
 * and the expiry arithmetic every refresh applies.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

let lineage: Array<Record<string, unknown>> | Error = [];
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { session: { maxAgeDays: 30, idleTimeoutDays: 7 } } } }));
jest.unstable_mockModule('../src/helpers/org-policy-lineage.js', () => ({
  readOrgPolicyLineage: async () => {
    if (lineage instanceof Error) throw lineage;
    return lineage;
  },
}));

const {
  interactiveSessionEnd, interactiveSessionExpired, platformSessionLimits, resolveEffectiveSessionPolicy, sessionLimitsFor,
} = await import('../src/helpers/session-policy.js');

const DAY = 86400_000;

beforeEach(() => {
  lineage = [];
});

describe('platformSessionLimits', () => {
  it('reads the env-configured ceiling', () => {
    expect(platformSessionLimits()).toEqual({ maxAgeDays: 30, idleTimeoutDays: 7 });
  });
});

describe('resolveEffectiveSessionPolicy', () => {
  it('an org with no policy gets the platform ceiling', async () => {
    lineage = [{ _id: 'org-1' }];
    await expect(resolveEffectiveSessionPolicy('org-1')).resolves.toEqual({
      maxAgeDays: 30, idleTimeoutDays: 7, own: {}, platform: { maxAgeDays: 30, idleTimeoutDays: 7 },
    });
  });

  it('an org may only TIGHTEN: a looser own value leaves the platform bound in force', async () => {
    lineage = [{ _id: 'org-1', sessionPolicy: { maxAgeDays: 90, idleTimeoutDays: 2 } }];
    const p = await resolveEffectiveSessionPolicy('org-1');
    expect(p).toMatchObject({ maxAgeDays: 30, idleTimeoutDays: 2, own: { maxAgeDays: 90, idleTimeoutDays: 2 } });
  });

  it('the strictest ancestor wins, per field, and is named', async () => {
    lineage = [
      { _id: 'team', sessionPolicy: { maxAgeDays: 10 } },
      { _id: 'mid', sessionPolicy: { idleTimeoutDays: 3 } },
      { _id: 'root', sessionPolicy: { maxAgeDays: 5, idleTimeoutDays: 4 } },
    ];
    const p = await resolveEffectiveSessionPolicy('team');
    expect(p).toMatchObject({ maxAgeDays: 5, maxAgeInheritedFrom: 'root', idleTimeoutDays: 3, idleTimeoutInheritedFrom: 'mid' });
  });

  it('ignores a malformed stored value', async () => {
    lineage = [{ _id: 'org-1', sessionPolicy: { maxAgeDays: 0, idleTimeoutDays: 'x' } }];
    await expect(resolveEffectiveSessionPolicy('org-1')).resolves.toMatchObject({ maxAgeDays: 30, idleTimeoutDays: 7, own: {} });
  });

  it('fails OPEN to the platform ceiling on a read error', async () => {
    lineage = new Error('mongo down');
    await expect(resolveEffectiveSessionPolicy('org-1')).resolves.toMatchObject({ maxAgeDays: 30, idleTimeoutDays: 7 });
  });
});

describe('sessionLimitsFor', () => {
  it('is the platform ceiling with no org', async () => {
    await expect(sessionLimitsFor([undefined])).resolves.toEqual({ maxAgeDays: 30, idleTimeoutDays: 7 });
  });

  it('is the strictest across the given orgs', async () => {
    lineage = [{ _id: 'o', sessionPolicy: { maxAgeDays: 12 } }];
    await expect(sessionLimitsFor(['o', 'o'])).resolves.toEqual({ maxAgeDays: 12, idleTimeoutDays: 7 });
  });
});

describe('interactive session expiry', () => {
  const limits = { maxAgeDays: 30, idleTimeoutDays: 7 };
  const now = new Date('2026-06-01T00:00:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  it('computes both bounds', () => {
    const end = interactiveSessionEnd({ authTime: ago(10), lastUsedAt: ago(1) }, limits);
    expect(end.absoluteEnd.getTime()).toBe(ago(10).getTime() + 30 * DAY);
    expect(end.idleEnd.getTime()).toBe(ago(1).getTime() + 7 * DAY);
  });

  it.each([
    ['inside both bounds', 10, 1, false],
    ['idle past the timeout', 10, 8, true],
    ['past the maximum age however active', 31, 0, true],
    ['exactly at the idle bound', 7, 7, true],
  ])('%s', (_label, signedIn, used, expired) => {
    expect(interactiveSessionExpired({ authTime: ago(signedIn), lastUsedAt: ago(used) }, limits, now)).toBe(expired);
  });
});
