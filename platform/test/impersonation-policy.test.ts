// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the impersonation policy RESOLVER — the single owner of the defaults.
 *
 * The case that matters most is the absent field. Organizations are read through
 * `.lean()`, which bypasses Mongoose hydration, so a document that predates the
 * field arrives with it `undefined` and a schema `default:` never fires. If the
 * default lived anywhere but here, new and existing orgs could silently diverge.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockCountDocuments = jest.fn<(...a: unknown[]) => Promise<number>>();
const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { countDocuments: (...a: unknown[]) => mockCountDocuments(...a) },
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));

const {
  resolveImpersonationPolicy,
  canSelectDeniedPolicy,
  combineStrictest,
  resolveEffectiveImpersonationPolicy,
  STRICTEST_POLICY,
  DEFAULT_IMPERSONATION_POLICY,
  DEFAULT_ALLOW_SELF_APPROVAL,
} = await import('../src/helpers/impersonation-policy.js');

/** findById(...).select(...).lean() → doc, per org id. */
function orgs(byId: Record<string, unknown>) {
  mockOrgFindById.mockImplementation((id: unknown) => ({
    select: () => ({ lean: () => Promise.resolve(byId[String(id)] ?? null) }),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveImpersonationPolicy', () => {
  it('resolves an org document with NEITHER field to the documented defaults', () => {
    // Exactly what `.lean()` returns for an org created before the field existed.
    const legacyLeanDoc: { _id: string; name: string; impersonationPolicy?: unknown } = { _id: 'org-a', name: 'Org A' };

    expect(resolveImpersonationPolicy(legacyLeanDoc)).toEqual({
      policy: 'consent',
      allowSelfApproval: true,
    });
  });

  it('pins the defaults to consent + self-approval allowed', () => {
    // A change here is a product decision, not a refactor — it flips every org
    // that never chose a policy.
    expect(DEFAULT_IMPERSONATION_POLICY).toBe('consent');
    expect(DEFAULT_ALLOW_SELF_APPROVAL).toBe(true);
  });

  it('resolves a null or missing org to the defaults', () => {
    expect(resolveImpersonationPolicy(null)).toEqual({ policy: 'consent', allowSelfApproval: true });
    expect(resolveImpersonationPolicy(undefined)).toEqual({ policy: 'consent', allowSelfApproval: true });
  });

  it('honours an explicitly stored policy', () => {
    expect(resolveImpersonationPolicy({ impersonationPolicy: 'open' }).policy).toBe('open');
    expect(resolveImpersonationPolicy({ impersonationPolicy: 'denied' }).policy).toBe('denied');
  });

  it('honours an explicit allowSelfApproval: false', () => {
    // `false` is falsy — a naive `?? true` would be fine, but a `|| true` would
    // silently re-enable self-approval for an org that turned it off.
    expect(resolveImpersonationPolicy({ allowSelfApproval: false }).allowSelfApproval).toBe(false);
  });

  it('never trusts an unrecognised stored value as "open"', () => {
    // A corrupted or future mode must fall back to the gated default, never to
    // the most permissive reading.
    expect(resolveImpersonationPolicy({ impersonationPolicy: 'wide-open' }).policy).toBe('consent');
    expect(resolveImpersonationPolicy({ impersonationPolicy: 42 }).policy).toBe('consent');
    expect(resolveImpersonationPolicy({ allowSelfApproval: 'yes' }).allowSelfApproval).toBe(true);
  });
});

describe('canSelectDeniedPolicy', () => {
  it('refuses "denied" on a single-sysadmin deployment', async () => {
    mockCountDocuments.mockResolvedValue(1);
    // Four-eyes break-glass needs a second approver; with one sysadmin, "denied"
    // would make emergency access impossible — a lockout, not a control.
    await expect(canSelectDeniedPolicy()).resolves.toBe(false);
  });

  it('allows "denied" once a second sysadmin exists', async () => {
    mockCountDocuments.mockResolvedValue(2);
    await expect(canSelectDeniedPolicy()).resolves.toBe(true);
  });

  it('counts sysadmins, not all users', async () => {
    mockCountDocuments.mockResolvedValue(3);
    await canSelectDeniedPolicy();
    expect(mockCountDocuments).toHaveBeenCalledWith({ isSuperAdmin: true });
  });
});

describe('combineStrictest', () => {
  const p = (policy: 'open' | 'consent' | 'denied', allowSelfApproval = true) => ({ policy, allowSelfApproval });

  it('a team cannot LOOSEN below its parent', () => {
    expect(combineStrictest(p('open'), p('consent')).policy).toBe('consent');
    expect(combineStrictest(p('consent'), p('denied')).policy).toBe('denied');
  });

  it('a team CAN tighten beyond its parent', () => {
    expect(combineStrictest(p('denied'), p('consent')).policy).toBe('denied');
  });

  it('allows self-approval only when BOTH allow it', () => {
    expect(combineStrictest(p('consent', true), p('consent', true)).allowSelfApproval).toBe(true);
    expect(combineStrictest(p('consent', true), p('consent', false)).allowSelfApproval).toBe(false);
    expect(combineStrictest(p('consent', false), p('consent', true)).allowSelfApproval).toBe(false);
  });
});

describe('resolveEffectiveImpersonationPolicy', () => {
  it('a root org resolves to its own policy', async () => {
    orgs({ root: { impersonationPolicy: 'open', allowSelfApproval: true, parentOrgId: null } });

    const out = await resolveEffectiveImpersonationPolicy('root');
    expect(out).toMatchObject({ policy: 'open', resolved: true });
    expect(out.inheritedFrom).toBeUndefined();
  });

  it('a team set to OPEN under a CONSENT parent is governed by consent, and says why', async () => {
    orgs({
      team: { impersonationPolicy: 'open', allowSelfApproval: true, parentOrgId: 'parent' },
      parent: { impersonationPolicy: 'consent', allowSelfApproval: true },
    });

    const out = await resolveEffectiveImpersonationPolicy('team');
    expect(out.policy).toBe('consent');
    // The admin who chose `open` can see it was overridden, and by whom.
    expect(out.own.policy).toBe('open');
    expect(out.inheritedFrom).toBe('parent');
    expect(out.resolved).toBe(true);
  });

  it('a parent that never set a policy still binds its teams to the consent DEFAULT', async () => {
    // The absent-field default and strictest-wins interact: a legacy parent with
    // no stored policy resolves to `consent`, so its team's `open` does not stand.
    orgs({
      'team': { impersonationPolicy: 'open', parentOrgId: 'legacy-parent' },
      'legacy-parent': { name: 'predates the field' },
    });

    await expect(resolveEffectiveImpersonationPolicy('team')).resolves.toMatchObject({ policy: 'consent' });
  });

  it('a team stricter than its parent keeps its own policy, with no inheritance', async () => {
    orgs({
      team: { impersonationPolicy: 'denied', allowSelfApproval: false, parentOrgId: 'parent' },
      parent: { impersonationPolicy: 'consent', allowSelfApproval: true },
    });

    const out = await resolveEffectiveImpersonationPolicy('team');
    expect(out.policy).toBe('denied');
    expect(out.inheritedFrom).toBeUndefined();
  });

  it('FAILS CLOSED when the parent lookup throws — never falls back to the team\'s own', async () => {
    mockOrgFindById.mockImplementation((id: unknown) => ({
      select: () => ({
        lean: () => (String(id) === 'team'
          ? Promise.resolve({ impersonationPolicy: 'open', parentOrgId: 'parent' })
          : Promise.reject(new Error('mongo down'))),
      }),
    }));

    const out = await resolveEffectiveImpersonationPolicy('team');
    // Falling back to `open` here would be a false pass, exactly when we
    // couldn't check.
    expect(out).toMatchObject({ ...STRICTEST_POLICY, resolved: false });
  });

  it('FAILS CLOSED on a dangling parentOrgId', async () => {
    orgs({ team: { impersonationPolicy: 'open', parentOrgId: 'gone' } });

    await expect(resolveEffectiveImpersonationPolicy('team')).resolves.toMatchObject({
      ...STRICTEST_POLICY, resolved: false,
    });
  });
});
