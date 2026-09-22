// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `apiKeyService.exchange` — the resolution half of `POST /auth/token/exchange`.
 *
 * The controller's half (the opaque 401, the audit attribution) is in
 * `token-exchange-controller.test.ts`; the CLAIMS a minted token carries
 * (subset ∩ the holder's current permissions, a capability scope forcing
 * `permissions: []`) are in `token-permission-subset.test.ts`. This suite is the
 * layer between them — and it ran only in the Mongo-gated
 * `access-keys.integration.test.ts` before, so on an ordinary run nothing
 * exercised it.
 *
 * Its whole job is to decide WHETHER a key still speaks for anyone, on every
 * exchange rather than at mint time: a revoked or expired record, an account
 * that is gone, a membership that was removed, an org that was soft-deleted. A
 * regression in any of these is a credential that outlives the authority it was
 * issued against.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

let record: any = null;
const mockPatUpdateOne = jest.fn<(...a: unknown[]) => any>(() => ({ catch: () => undefined }));
const users = new Map<string, any>();

jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {
    findOne: (filter: any) => ({ lean: async () => (record && record.keyHash === filter.keyHash ? { ...record } : null) }),
    updateOne: (...a: unknown[]) => mockPatUpdateOne(...a),
  },
  User: {
    findById: (id: unknown) => ({ select: async () => users.get(String(id)) ?? null }),
  },
}));

const mockMembershipForOrg = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockSignApiKeyToken = jest.fn<(...a: unknown[]) => Promise<string>>(async () => 'minted.user.jwt');
const mockSignServiceAccountToken = jest.fn<(...a: unknown[]) => Promise<string>>(async () => 'minted.sa.jwt');
const mockEnforceOrgAssurance = jest.fn<(...a: any[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/utils/token.js', () => ({
  hashRefreshToken: (t: string) => `h:${t}`,
  enforceOrgAssurance: (...a: unknown[]) => mockEnforceOrgAssurance(...a),
  membershipForOrg: (...a: unknown[]) => mockMembershipForOrg(...a),
  signApiKeyToken: (...a: unknown[]) => mockSignApiKeyToken(...a),
  signServiceAccountToken: (...a: unknown[]) => mockSignServiceAccountToken(...a),
}));

const mockResolveServiceAccount = jest.fn<(...a: unknown[]) => Promise<any>>();
jest.unstable_mockModule('../src/services/service-account-service.js', () => ({
  resolveServiceAccountExchange: (...a: unknown[]) => mockResolveServiceAccount(...a),
}));

const { apiKeyService } = await import('../src/services/api-key-service.js');
const { generateApiKey, hashApiKey, API_KEY_TOKEN_TTL_SECONDS } = await import('@pipeline-builder/api-core');

const USER_ID = '651111111111111111111111';
const PAT = generateApiKey('pb_pat');
const SA_KEY = generateApiKey('pb_sa');

/** Store the record a key resolves to, exactly as the collection would. */
function storeKey(raw: string, over: Record<string, unknown> = {}): void {
  record = {
    _id: 'key-1',
    keyHash: hashApiKey(raw),
    name: 'ci-deploy',
    revoked: false,
    expiresAt: new Date(Date.now() + 86_400_000),
    userId: USER_ID,
    serviceAccountId: null,
    amr: ['pwd'],
    aal: 1,
    authTime: new Date('2026-09-01T00:00:00.000Z'),
    organizationId: 'org-1',
    ...over,
  };
}

const membership = { organizationId: 'org-1', organizationName: 'Acme', role: 'member', tier: 'pro', rolePermissions: ['pipelines:read'] };

beforeEach(() => {
  jest.clearAllMocks();
  record = null;
  users.clear();
  users.set(USER_ID, { _id: USER_ID, email: 'holder@acme.test', username: 'holder', tokenVersion: 3 });
  mockMembershipForOrg.mockResolvedValue(membership);
  mockSignApiKeyToken.mockResolvedValue('minted.user.jwt');
  mockPatUpdateOne.mockImplementation(() => ({ catch: () => undefined }));
  // Faithful to utils/token.ts: an org past its MFA grace refuses a
  // single-factor, unscoped credential; everything else passes through.
  mockEnforceOrgAssurance.mockImplementation(async (_user: unknown, m: any, auth: any, opts: any) => {
    if (m?.mfaEnforced && !opts?.scope && auth.aal < 2) throw new Error('MFA_REQUIRED_FOR_ORG');
    return auth;
  });
});

describe('a personal access key', () => {
  it('exchanges, and reports the key, its owner and its org', async () => {
    storeKey(PAT);

    const result = await apiKeyService.exchange(PAT, '203.0.113.7');

    expect(result).toEqual({
      ok: true,
      accessToken: 'minted.user.jwt',
      expiresIn: API_KEY_TOKEN_TTL_SECONDS,
      keyId: 'key-1',
      keyName: 'ci-deploy',
      userId: USER_ID,
      userEmail: 'holder@acme.test',
      principalType: 'user',
      organizationId: 'org-1',
    });
    // The keys page is accurate whichever service the key is actually used against.
    expect(mockPatUpdateOne).toHaveBeenCalledWith({ _id: 'key-1' }, { $set: { lastUsedAt: expect.any(Date) } });
  });

  it('hands the signer the key\'s SUBSET and its captured authentication, re-derived per exchange', async () => {
    // The intersection with the holder's current permissions happens in the
    // signer (see token-permission-subset.test.ts); what the exchange owes is
    // passing the subset and the original auth context through unchanged, so a
    // Role lost since the mint shrinks the token on the very next exchange.
    storeKey(PAT, { permissions: ['pipelines:read', 'billing:manage'], scope: null });

    await apiKeyService.exchange(PAT);

    expect(mockSignApiKeyToken).toHaveBeenCalledWith(
      expect.objectContaining({ _id: USER_ID }),
      membership,
      'key-1',
      { amr: ['pwd'], aal: 1, authTime: new Date('2026-09-01T00:00:00.000Z') },
      undefined,
      ['pipelines:read', 'billing:manage'],
    );
  });

  it('REFUSES a single-factor key once its org requires MFA — the same rule a session gets', async () => {
    storeKey(PAT);
    mockMembershipForOrg.mockResolvedValue({ ...membership, mfaEnforced: true });

    expect(await apiKeyService.exchange(PAT)).toEqual({ ok: false, reason: 'mfa_required' });
    expect(mockSignApiKeyToken).not.toHaveBeenCalled();
    // The org's authenticator allowlist is applied through the same call, with
    // the key's recorded passkey model.
    storeKey(PAT, { amr: ['webauthn'], aal: 2, aaguid: 'aaguid-1' });
    await apiKeyService.exchange(PAT);
    expect(mockEnforceOrgAssurance).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: USER_ID }),
      expect.objectContaining({ mfaEnforced: true }),
      expect.objectContaining({ amr: ['webauthn'], aal: 2, aaguid: 'aaguid-1' }),
      { scope: undefined },
    );
  });

  it('lets a capability-SCOPED key through an MFA-requiring org (the machine carve-out)', async () => {
    storeKey(PAT, { scope: 'reporting:ingest' });
    mockMembershipForOrg.mockResolvedValue({ ...membership, mfaEnforced: true });
    expect((await apiKeyService.exchange(PAT)).ok).toBe(true);
  });

  it('passes a capability SCOPE through (and reports it), carrying no subset', async () => {
    storeKey(PAT, { scope: 'reporting:ingest', permissions: null });

    const result = await apiKeyService.exchange(PAT);

    expect((result as any).scope).toBe('reporting:ingest');
    expect(mockSignApiKeyToken).toHaveBeenCalledWith(
      expect.anything(), membership, 'key-1', expect.anything(), 'reporting:ingest', undefined,
    );
  });

  it('exchanges an ORG-LESS key without consulting any membership', async () => {
    storeKey(PAT, { organizationId: null });

    const result = await apiKeyService.exchange(PAT);

    expect(result.ok).toBe(true);
    expect((result as any).organizationId).toBeUndefined();
    expect(mockMembershipForOrg).not.toHaveBeenCalled();
    expect(mockSignApiKeyToken).toHaveBeenCalledWith(expect.anything(), undefined, 'key-1', expect.anything(), undefined, undefined);
  });

  it('refuses a malformed credential without a database lookup', async () => {
    expect(await apiKeyService.exchange('Bearer eyJhbGciOi')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses an unknown, a REVOKED and an EXPIRED key', async () => {
    expect(await apiKeyService.exchange(PAT)).toEqual({ ok: false, reason: 'unknown' });

    storeKey(PAT, { revoked: true });
    expect(await apiKeyService.exchange(PAT)).toEqual({ ok: false, reason: 'revoked' });

    storeKey(PAT, { expiresAt: new Date(Date.now() - 1000) });
    expect(await apiKeyService.exchange(PAT)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a record whose OWNER FIELD disagrees with its prefix', async () => {
    // Not an identity either branch can reason about — routing by whichever
    // field happens to be set is how a personal key becomes a machine one.
    storeKey(PAT, { userId: null, serviceAccountId: 'sa-1' });
    expect(await apiKeyService.exchange(PAT)).toEqual({ ok: false, reason: 'orphan_key' });

    storeKey(SA_KEY, { userId: USER_ID, serviceAccountId: null });
    expect(await apiKeyService.exchange(SA_KEY)).toEqual({ ok: false, reason: 'orphan_key' });
  });

  it('refuses a key whose account is gone', async () => {
    storeKey(PAT);
    users.clear();
    expect(await apiKeyService.exchange(PAT)).toEqual({ ok: false, reason: 'user_gone' });
  });

  it('refuses a key whose ORG went away or whose membership was removed', async () => {
    // `membershipForOrg` answers undefined for a removed/deactivated membership
    // AND for a soft-deleted org. Issuing an org-less token here would let the
    // key act outside any tenant.
    storeKey(PAT);
    mockMembershipForOrg.mockResolvedValue(undefined);

    expect(await apiKeyService.exchange(PAT)).toEqual({ ok: false, reason: 'authority_revoked' });
    expect(mockSignApiKeyToken).not.toHaveBeenCalled();
  });

  it('does not fail the exchange when the lastUsedAt stamp fails', async () => {
    storeKey(PAT);
    mockPatUpdateOne.mockImplementation(() => ({ catch: (fn: (e: unknown) => void) => { fn(new Error('write concern')); } }));

    expect((await apiKeyService.exchange(PAT)).ok).toBe(true);
  });
});

describe('a service-account key', () => {
  beforeEach(() => {
    mockResolveServiceAccount.mockResolvedValue({
      ok: true,
      context: { id: 'sa-1', name: 'deploy-bot', organizationId: 'org-1', rolePermissions: [], role: 'member', isSuperAdmin: false },
    });
  });

  it('speaks for the ACCOUNT, at its sentinel address, never for its creator', async () => {
    storeKey(SA_KEY, { userId: null, serviceAccountId: 'sa-1', scope: 'registry:push', ipAllowlist: ['203.0.113.0/24'] });

    const result = await apiKeyService.exchange(SA_KEY, '203.0.113.7');

    expect(result).toEqual({
      ok: true,
      accessToken: 'minted.sa.jwt',
      expiresIn: API_KEY_TOKEN_TTL_SECONDS,
      keyId: 'key-1',
      keyName: 'ci-deploy',
      userId: 'sa-1',
      userEmail: 'deploy-bot@service-account.invalid',
      principalType: 'service_account',
      serviceAccountName: 'deploy-bot',
      organizationId: 'org-1',
      scope: 'registry:push',
    });
    // The presented address and the key's own allowlist are what the gate checks.
    expect(mockResolveServiceAccount).toHaveBeenCalledWith('sa-1', '203.0.113.7', ['203.0.113.0/24']);
  });

  it('exchanges a scope-less service-account key too', async () => {
    storeKey(SA_KEY, { userId: null, serviceAccountId: 'sa-1', scope: null });
    const result = await apiKeyService.exchange(SA_KEY);
    expect((result as any).scope).toBeUndefined();
    expect(mockSignServiceAccountToken).toHaveBeenCalledWith(expect.anything(), 'key-1', undefined);
  });

  it.each(['disabled', 'authority_revoked', 'ip_not_allowed', 'budget_exhausted'] as const)(
    'surfaces the account gate\'s own refusal (%s) rather than minting anything',
    async (reason) => {
      storeKey(SA_KEY, { userId: null, serviceAccountId: 'sa-1' });
      mockResolveServiceAccount.mockResolvedValue({ ok: false, reason });

      expect(await apiKeyService.exchange(SA_KEY)).toEqual({ ok: false, reason });
      expect(mockSignServiceAccountToken).not.toHaveBeenCalled();
    },
  );
});
