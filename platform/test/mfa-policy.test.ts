// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org "require MFA" RESOLVER (#8) — the single owner of the default, the
 * grace period and the ancestor walk.
 *
 * Like the impersonation policy, orgs are read through `.lean()`, which bypasses
 * Mongoose hydration: a document with no `requireMfa` field arrives `undefined`
 * and a schema `default:` never fires. The default therefore has to live here,
 * and "absent means off" has to be asserted rather than assumed.
 *
 * The grace period is the other thing worth pinning: it is what stops enabling
 * the policy from signing out everyone who has not enrolled yet — usually
 * including the admin who just enabled it.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));

const {
  DEFAULT_MFA_GRACE_DAYS,
  MAX_MFA_GRACE_DAYS,
  idpEnforcesMfa,
  resolveEffectiveMfaPolicy,
} = await import('../src/helpers/mfa-policy.js');

/** findById(...).select(...).lean() → doc, per org id. */
function orgs(byId: Record<string, unknown>) {
  mockOrgFindById.mockImplementation((id: unknown) => ({
    select: () => ({ lean: () => Promise.resolve(byId[String(id)] ?? null) }),
  }));
}

const NOW = new Date('2026-06-01T00:00:00.000Z');
const IN_A_WEEK = new Date('2026-06-08T00:00:00.000Z');
const LAST_WEEK = new Date('2026-05-25T00:00:00.000Z');

beforeEach(() => { jest.clearAllMocks(); });

describe('resolveEffectiveMfaPolicy', () => {
  it('treats an org with no stored field as not requiring MFA', async () => {
    orgs({ 'org-a': { _id: 'org-a', name: 'A' } });
    const policy = await resolveEffectiveMfaPolicy('org-a', NOW);
    expect(policy).toMatchObject({ requireMfa: false, enforced: false, own: false, idpEnforcesMfa: false });
    expect(policy.graceUntil).toBeUndefined();
  });

  it('treats a missing org as not requiring MFA rather than throwing', async () => {
    orgs({});
    await expect(resolveEffectiveMfaPolicy('gone', NOW)).resolves.toMatchObject({ requireMfa: false, enforced: false });
  });

  it('requires but does not yet ENFORCE while a grace period is running', async () => {
    orgs({ 'org-a': { _id: 'org-a', requireMfa: true, mfaGraceUntil: IN_A_WEEK, mfaRequiredSince: LAST_WEEK } });
    const policy = await resolveEffectiveMfaPolicy('org-a', NOW);
    // The distinction IS the grace period: members are told, not refused.
    expect(policy.requireMfa).toBe(true);
    expect(policy.enforced).toBe(false);
    expect(policy.graceUntil).toEqual(IN_A_WEEK);
    expect(policy.requiredSince).toEqual(LAST_WEEK);
  });

  it('enforces once the grace deadline has passed, and stops reporting it', async () => {
    orgs({ 'org-a': { _id: 'org-a', requireMfa: true, mfaGraceUntil: LAST_WEEK } });
    const policy = await resolveEffectiveMfaPolicy('org-a', NOW);
    expect(policy.enforced).toBe(true);
    expect(policy.graceUntil).toBeUndefined();
  });

  it('enforces immediately when no grace period was set', async () => {
    orgs({ 'org-a': { _id: 'org-a', requireMfa: true } });
    expect(await resolveEffectiveMfaPolicy('org-a', NOW)).toMatchObject({ requireMfa: true, enforced: true });
  });

  it('reports idpEnforcesMfa from the org\'s own document', async () => {
    orgs({ 'org-a': { _id: 'org-a', idpEnforcesMfa: true } });
    expect((await resolveEffectiveMfaPolicy('org-a', NOW)).idpEnforcesMfa).toBe(true);
  });

  describe('inheritance (strictest wins)', () => {
    it('applies a parent\'s ENFORCED requirement to a team that has none', async () => {
      orgs({
        team: { _id: 'team', parentOrgId: 'root' },
        root: { _id: 'root', requireMfa: true, mfaRequiredSince: LAST_WEEK },
      });
      const policy = await resolveEffectiveMfaPolicy('team', NOW);
      expect(policy).toMatchObject({ requireMfa: true, enforced: true, own: false, inheritedFrom: 'root' });
    });

    it('lets a parent\'s ENFORCED requirement override the team\'s own grace period', async () => {
      // A team cannot buy itself more time than its account allows.
      orgs({
        team: { _id: 'team', parentOrgId: 'root', requireMfa: true, mfaGraceUntil: IN_A_WEEK },
        root: { _id: 'root', requireMfa: true },
      });
      const policy = await resolveEffectiveMfaPolicy('team', NOW);
      expect(policy.enforced).toBe(true);
      expect(policy.graceUntil).toBeUndefined();
      expect(policy.own).toBe(true);
    });

    it('keeps a team\'s own requirement when the parent has none', async () => {
      orgs({
        team: { _id: 'team', parentOrgId: 'root', requireMfa: true },
        root: { _id: 'root' },
      });
      expect(await resolveEffectiveMfaPolicy('team', NOW)).toMatchObject({ requireMfa: true, enforced: true, own: true });
      expect((await resolveEffectiveMfaPolicy('team', NOW)).inheritedFrom).toBeUndefined();
    });

    it('costs no ancestor read for a flat org', async () => {
      orgs({ 'org-a': { _id: 'org-a', requireMfa: true } });
      await resolveEffectiveMfaPolicy('org-a', NOW);
      expect(mockOrgFindById).toHaveBeenCalledTimes(1);
    });

    it('stops on a parent cycle instead of walking forever', async () => {
      orgs({
        a: { _id: 'a', parentOrgId: 'b' },
        b: { _id: 'b', parentOrgId: 'a', requireMfa: true },
      });
      const policy = await resolveEffectiveMfaPolicy('a', NOW);
      expect(policy.requireMfa).toBe(true);
      expect(policy.inheritedFrom).toBe('b');
    });

    it('degrades to the org\'s own setting when the ancestor walk fails', async () => {
      // A transient read blip must not refuse every sign-in for the account.
      mockOrgFindById.mockImplementationOnce(() => ({
        select: () => ({ lean: () => Promise.resolve({ _id: 'team', parentOrgId: 'root', requireMfa: false }) }),
      })).mockImplementation(() => ({
        select: () => ({ lean: () => Promise.reject(new Error('mongo down')) }),
      }));
      await expect(resolveEffectiveMfaPolicy('team', NOW)).resolves.toMatchObject({ requireMfa: false, enforced: false });
    });
  });
});

describe('idpEnforcesMfa', () => {
  it('reads only the org\'s own statement — it describes THAT provider', async () => {
    orgs({ team: { _id: 'team', parentOrgId: 'root' }, root: { _id: 'root', idpEnforcesMfa: true } });
    expect(await idpEnforcesMfa('team')).toBe(false);
  });

  it('is false for an org that does not exist', async () => {
    orgs({});
    expect(await idpEnforcesMfa('gone')).toBe(false);
  });
});

describe('grace-period constants', () => {
  it('pins the default and the ceiling — both are product decisions', () => {
    expect(DEFAULT_MFA_GRACE_DAYS).toBe(14);
    expect(MAX_MFA_GRACE_DAYS).toBe(90);
  });
});

describe('administrative actions require MFA (adminActionsRequireMfa)', () => {
  it('is off by default', async () => {
    orgs({ 'org-a': { _id: 'org-a' } });
    expect(await resolveEffectiveMfaPolicy('org-a', NOW)).toMatchObject({ adminActionsRequireMfa: false, adminActionsOwn: false });
  });

  it('reads the org\'s own setting, independent of requireMfa', async () => {
    orgs({ 'org-a': { _id: 'org-a', adminActionsRequireMfa: true } });
    expect(await resolveEffectiveMfaPolicy('org-a', NOW)).toMatchObject({
      requireMfa: false, adminActionsRequireMfa: true, adminActionsOwn: true,
    });
  });

  it('applies a parent\'s setting to its team (strictest wins), naming the parent', async () => {
    orgs({
      team: { _id: 'team', parentOrgId: 'root' },
      root: { _id: 'root', adminActionsRequireMfa: true },
    });
    const policy = await resolveEffectiveMfaPolicy('team', NOW);
    expect(policy).toMatchObject({ adminActionsRequireMfa: true, adminActionsOwn: false, adminActionsInheritedFrom: 'root' });
    // …without implying the (separate) sign-in requirement.
    expect(policy.requireMfa).toBe(false);
  });

  it('keeps a team\'s own setting when the parent has none', async () => {
    orgs({
      team: { _id: 'team', parentOrgId: 'root', adminActionsRequireMfa: true },
      root: { _id: 'root' },
    });
    const policy = await resolveEffectiveMfaPolicy('team', NOW);
    expect(policy).toMatchObject({ adminActionsRequireMfa: true, adminActionsOwn: true });
    expect(policy.adminActionsInheritedFrom).toBeUndefined();
  });
});
