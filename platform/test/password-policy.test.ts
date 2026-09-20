// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Password policy: the HIBP k-anonymity breach check (fail-open, metered) and
 * the per-org minimum length (strictest wins across the org lineage and across
 * every org a person belongs to).
 */

import crypto from 'crypto';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const breachSettings = { mode: 'hibp' as 'hibp' | 'off', rangeUrl: 'https://hibp.test/range/', timeoutMs: 50 };
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { auth: { passwordMinLength: 8, passwordBreachCheck: breachSettings } },
}));
const mockIncCounter = jest.fn();
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: mockIncCounter }));

/** Lineage per org id: [self, parent, …]. */
let lineages: Record<string, Array<{ _id: string; passwordMinLength?: number }>> = {};
jest.unstable_mockModule('../src/helpers/org-policy-lineage.js', () => ({
  readOrgPolicyLineage: async (orgId: string) => {
    if (orgId === 'broken') throw new Error('db down');
    return lineages[orgId] ?? [];
  },
}));
let memberships: Array<{ organizationId: string }> = [];
let invitation: Record<string, unknown> | null = null;
jest.unstable_mockModule('../src/models/index.js', () => ({
  UserOrganization: { find: () => ({ select: () => ({ lean: async () => memberships }) }) },
  Invitation: { findOne: () => ({ select: () => ({ lean: async () => invitation }) }) },
}));

const breach = await import('../src/services/password-breach.js');
const policy = await import('../src/helpers/password-policy.js');

const realFetch = globalThis.fetch;
function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = jest.fn(impl) as unknown as typeof fetch;
}
/** A range body containing the password's suffix with `count`, plus padding. */
function rangeFor(password: string, count: number): string {
  const { suffix } = breach.breachHashParts(password);
  return ['0000000000000000000000000000000000A:0', `${suffix}:${count}`, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:3'].join('\r\n');
}

beforeEach(() => {
  breachSettings.mode = 'hibp';
  mockIncCounter.mockClear();
  lineages = {};
  memberships = [];
  invitation = null;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('breached-password check (HIBP range API)', () => {
  it('sends only the 5-char SHA-1 prefix, padded, and matches the suffix locally', async () => {
    let calledUrl = '';
    let headers: Record<string, string> = {};
    mockFetch(async (url, init) => {
      calledUrl = url;
      headers = init?.headers as Record<string, string>;
      return new Response(rangeFor('Password1', 42), { status: 200 });
    });
    const out = await breach.checkPasswordBreach('Password1');
    const sha1 = crypto.createHash('sha1').update('Password1').digest('hex').toUpperCase();
    expect(calledUrl).toBe(`https://hibp.test/range/${sha1.slice(0, 5)}`);
    expect(calledUrl).not.toContain(sha1.slice(5));
    expect(headers['Add-Padding']).toBe('true');
    expect(out).toEqual({ outcome: 'breached', count: 42 });
    expect(mockIncCounter).toHaveBeenCalledWith('platform_password_breach_checks_total', { outcome: 'breached' });
  });

  it('a padded (count 0) or absent suffix is clean', async () => {
    mockFetch(async () => new Response(rangeFor('Password1', 0), { status: 200 }));
    expect(await breach.checkPasswordBreach('Password1')).toEqual({ outcome: 'clean' });
    mockFetch(async () => new Response('ABCDEF:1', { status: 200 }));
    expect(await breach.checkPasswordBreach('Password1')).toEqual({ outcome: 'clean' });
  });

  it('FAILS OPEN on an error status, a network error, or a timeout — and meters it', async () => {
    mockFetch(async () => new Response('nope', { status: 503 }));
    expect(await breach.checkPasswordBreach('Password1')).toEqual({ outcome: 'unavailable' });
    mockFetch(async () => { throw new TypeError('fetch failed'); });
    expect(await breach.checkPasswordBreach('Password1')).toEqual({ outcome: 'unavailable' });
    mockFetch((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
    }));
    expect(await breach.checkPasswordBreach('Password1')).toEqual({ outcome: 'unavailable' });
    expect(mockIncCounter).toHaveBeenCalledWith('platform_password_breach_checks_total', { outcome: 'unavailable' });
  });

  it('does nothing when configured off', async () => {
    breachSettings.mode = 'off';
    mockFetch(async () => { throw new Error('must not be called'); });
    expect(await breach.checkPasswordBreach('Password1')).toEqual({ outcome: 'skipped' });
  });
});

describe('org password policy', () => {
  it('defaults to the platform floor', async () => {
    lineages = { a: [{ _id: 'a' }] };
    expect(await policy.resolveEffectivePasswordPolicy('a')).toEqual({ minLength: 8, platformMinLength: 8 });
  });

  it('takes the org\'s own minimum, and a STRICTER ancestor wins over it', async () => {
    lineages = {
      team: [{ _id: 'team', passwordMinLength: 12 }, { _id: 'root', passwordMinLength: 16 }],
      lax: [{ _id: 'lax', passwordMinLength: 14 }, { _id: 'root2', passwordMinLength: 10 }],
    };
    expect(await policy.resolveEffectivePasswordPolicy('team')).toMatchObject({ minLength: 16, own: 12, inheritedFrom: 'root' });
    // A laxer ancestor never lowers the team's own bar.
    const lax = await policy.resolveEffectivePasswordPolicy('lax');
    expect(lax).toMatchObject({ minLength: 14, own: 14 });
    expect(lax.inheritedFrom).toBeUndefined();
  });

  it('fails open to the platform floor on a read error', async () => {
    expect(await policy.resolveEffectivePasswordPolicy('broken')).toEqual({ minLength: 8, platformMinLength: 8 });
  });

  it('a person answers to the strictest of their orgs (plus an inviting org)', async () => {
    lineages = { a: [{ _id: 'a', passwordMinLength: 10 }], b: [{ _id: 'b', passwordMinLength: 14 }], inv: [{ _id: 'inv', passwordMinLength: 20 }] };
    memberships = [{ organizationId: 'a' }, { organizationId: 'b' }];
    expect(await policy.passwordPolicyForPerson('u1')).toEqual({ minLength: 14, orgId: 'b' });
    expect(await policy.passwordPolicyForPerson('u1', ['inv'])).toEqual({ minLength: 20, orgId: 'inv' });
    expect(await policy.passwordPolicyForPerson(undefined)).toEqual({ minLength: 8 });
  });

  it('assertNewPasswordAcceptable refuses a password below the org minimum, then a breached one', async () => {
    lineages = { a: [{ _id: 'a', passwordMinLength: 16 }] };
    memberships = [{ organizationId: 'a' }];
    mockFetch(async () => new Response('', { status: 200 }));
    await expect(policy.assertNewPasswordAcceptable('Short1Pass', { userId: 'u1' }))
      .rejects.toMatchObject({ code: 'PASSWORD_TOO_SHORT_FOR_ORG', statusCode: 400, name: 'PasswordPolicyServiceError' });

    mockFetch(async () => new Response(rangeFor('LongEnough1Password', 7), { status: 200 }));
    await expect(policy.assertNewPasswordAcceptable('LongEnough1Password', { userId: 'u1' }))
      .rejects.toMatchObject({ code: 'PASSWORD_BREACHED', statusCode: 400 });

    mockFetch(async () => new Response('', { status: 200 }));
    await expect(policy.assertNewPasswordAcceptable('LongEnough1Password', { userId: 'u1' })).resolves.toBeUndefined();
  });

  it('passwordShortfall flags an EXISTING password below the person\'s policy', async () => {
    lineages = { a: [{ _id: 'a', passwordMinLength: 12 }] };
    memberships = [{ organizationId: 'a' }];
    expect(await policy.passwordShortfall('Only9Char', 'u1')).toEqual({ minLength: 12, orgId: 'a' });
    expect(await policy.passwordShortfall('TwelveChars1', 'u1')).toBeNull();
  });

  it('invitationOrgForRegistration only honours a live invitation to that email', async () => {
    invitation = { organizationId: 'org-9', email: 'new@example.com', expiresAt: new Date(Date.now() + 60_000) };
    expect(await policy.invitationOrgForRegistration('tok', 'New@Example.com ')).toBe('org-9');
    expect(await policy.invitationOrgForRegistration('tok', 'other@example.com')).toBeUndefined();
    invitation = { organizationId: 'org-9', email: 'new@example.com', expiresAt: new Date(Date.now() - 1) };
    expect(await policy.invitationOrgForRegistration('tok', 'new@example.com')).toBeUndefined();
    invitation = null;
    expect(await policy.invitationOrgForRegistration('tok', 'new@example.com')).toBeUndefined();
  });
});
