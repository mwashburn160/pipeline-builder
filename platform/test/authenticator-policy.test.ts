// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org authenticator (AAGUID) policy: normalization, strictest-wins inheritance
 * (intersection), the issuance-time demotion of a non-allowlisted passkey to
 * `aal: 1`, and the FIDO Metadata Service snapshot the registration check uses.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const YUBIKEY = 'cb69481e-8ff7-4039-93ec-0a2729a154a8';
const TITAN = '42b4fb4a-2866-43b2-9bf7-6c6669c2e5d3';
const ICLOUD = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd';

let lineages: Record<string, Array<{ _id: string; allowedAuthenticatorAaguids?: string[] }>> = {};
jest.unstable_mockModule('../src/helpers/org-policy-lineage.js', () => ({
  readOrgPolicyLineage: async (orgId: string) => {
    if (orgId === 'broken') throw new Error('db down');
    return lineages[orgId] ?? [];
  },
}));
const mockIncCounter = jest.fn();
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: mockIncCounter }));

const mds = { blobPath: '/tmp/mds.jwt' as string | undefined, url: undefined as string | undefined, fetchTimeoutMs: 100, refreshMs: 60_000 };
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { webauthn: { mds } } } }));
const mockReadFile = jest.fn(async () => 'blob.jwt');
jest.unstable_mockModule('fs/promises', () => ({ readFile: mockReadFile }));
const mockVerifyMDSBlob = jest.fn<(blob: string) => Promise<unknown>>();
jest.unstable_mockModule('@simplewebauthn/server/helpers', () => ({ verifyMDSBlob: mockVerifyMDSBlob }));
const mockInitialize = jest.fn(async () => undefined);
jest.unstable_mockModule('@simplewebauthn/server', () => ({ MetadataService: { initialize: mockInitialize } }));

const policy = await import('../src/helpers/authenticator-policy.js');
const fidoMds = await import('../src/services/fido-mds.js');

const passkeySession = (aaguid?: string) => ({
  amr: ['webauthn' as const], aal: 2 as const, authTime: new Date(0), ...(aaguid ? { aaguid } : {}),
});

beforeEach(() => {
  lineages = {};
  mockIncCounter.mockClear();
  mockVerifyMDSBlob.mockReset();
  mockInitialize.mockClear();
  mockReadFile.mockClear();
  fidoMds._setMdsModelsForTests(null);
});

describe('normalizeAaguid', () => {
  it('lowercases a canonical AAGUID and refuses anything else, including the all-zero one', () => {
    expect(policy.normalizeAaguid(` ${YUBIKEY.toUpperCase()} `)).toBe(YUBIKEY);
    expect(policy.normalizeAaguid('not-a-guid')).toBeNull();
    expect(policy.normalizeAaguid(policy.ZERO_AAGUID)).toBeNull();
    expect(policy.normalizeAaguid(42)).toBeNull();
  });
});

describe('effective allowlist', () => {
  it('no list anywhere → any model', async () => {
    lineages = { a: [{ _id: 'a' }] };
    expect((await policy.resolveEffectiveAuthenticatorPolicy('a')).allowed).toBeNull();
  });

  it('lists along the lineage INTERSECT (a team can narrow, never widen)', async () => {
    lineages = {
      team: [{ _id: 'team', allowedAuthenticatorAaguids: [YUBIKEY, ICLOUD] }, { _id: 'root', allowedAuthenticatorAaguids: [YUBIKEY, TITAN] }],
      bare: [{ _id: 'bare' }, { _id: 'root', allowedAuthenticatorAaguids: [TITAN] }],
    };
    const team = await policy.resolveEffectiveAuthenticatorPolicy('team');
    expect(team.allowed).toEqual([YUBIKEY]);
    expect(team.inheritedFrom).toEqual(['root']);
    expect((await policy.resolveEffectiveAuthenticatorPolicy('bare')).allowed).toEqual([TITAN]);
  });

  it('aaguidPermitted', () => {
    expect(policy.aaguidPermitted({ allowed: null }, undefined)).toBe(true);
    expect(policy.aaguidPermitted({ allowed: [YUBIKEY] }, YUBIKEY.toUpperCase())).toBe(true);
    expect(policy.aaguidPermitted({ allowed: [YUBIKEY] }, TITAN)).toBe(false);
    expect(policy.aaguidPermitted({ allowed: [YUBIKEY] }, undefined)).toBe(false);
    expect(policy.aaguidPermitted({ allowed: [] }, YUBIKEY)).toBe(false);
  });
});

describe('applyAuthenticatorPolicy (issuance)', () => {
  it('leaves a passkey on the list at aal 2', async () => {
    lineages = { org: [{ _id: 'org', allowedAuthenticatorAaguids: [YUBIKEY] }] };
    expect((await policy.applyAuthenticatorPolicy(passkeySession(YUBIKEY), 'org')).aal).toBe(2);
  });

  it('demotes a passkey NOT on the list to aal 1 — it signs in, but is not MFA here', async () => {
    lineages = { org: [{ _id: 'org', allowedAuthenticatorAaguids: [YUBIKEY] }] };
    const out = await policy.applyAuthenticatorPolicy(passkeySession(ICLOUD), 'org');
    expect(out).toMatchObject({ amr: ['webauthn'], aal: 1, aaguid: ICLOUD });
    expect(mockIncCounter).toHaveBeenCalledWith('platform_authenticator_policy_demotions_total');
    // A session with no recorded model can't prove it is on the list either.
    expect((await policy.applyAuthenticatorPolicy(passkeySession(), 'org')).aal).toBe(1);
  });

  it('leaves every non-passkey session alone', async () => {
    lineages = { org: [{ _id: 'org', allowedAuthenticatorAaguids: [YUBIKEY] }] };
    const totp = { amr: ['pwd' as const, 'mfa' as const], aal: 2 as const, authTime: new Date(0) };
    expect(await policy.applyAuthenticatorPolicy(totp, 'org')).toBe(totp);
  });

  it('fails CLOSED on assurance when the policy cannot be read', async () => {
    expect((await policy.applyAuthenticatorPolicy(passkeySession(YUBIKEY), 'broken')).aal).toBe(1);
  });
});

describe('FIDO Metadata Service snapshot', () => {
  const entries = [
    { aaguid: YUBIKEY.toUpperCase(), metadataStatement: { description: 'YubiKey 5 Series' }, statusReports: [{ status: 'FIDO_CERTIFIED_L2' }] },
    { aaguid: TITAN, metadataStatement: { description: 'Titan' }, statusReports: [{ status: 'ATTESTATION_KEY_COMPROMISE' }] },
    { aaguid: ICLOUD }, // no statement → not a model we can vouch for
  ];

  it('modelsFromEntries keeps named models and flags compromised ones', () => {
    const { models, statements } = fidoMds.modelsFromEntries(entries as never);
    expect(statements).toHaveLength(2);
    expect(models.get(YUBIKEY)).toEqual({ aaguid: YUBIKEY, description: 'YubiKey 5 Series', compromised: false });
    expect(models.get(TITAN)?.compromised).toBe(true);
    expect(models.has(ICLOUD)).toBe(false);
  });

  it('loads a VERIFIED blob from the configured path and seeds SimpleWebAuthn', async () => {
    mockVerifyMDSBlob.mockResolvedValue({ payload: { no: 7, entries } });
    expect(await fidoMds.lookupModel(YUBIKEY)).toMatchObject({ description: 'YubiKey 5 Series' });
    expect(mockReadFile).toHaveBeenCalledWith('/tmp/mds.jwt', 'utf8');
    expect(mockVerifyMDSBlob).toHaveBeenCalledWith('blob.jwt');
    expect(mockInitialize).toHaveBeenCalledWith(expect.objectContaining({ mdsServers: [], verificationMode: 'permissive' }));
    expect(await fidoMds.lookupModel(ICLOUD)).toBeUndefined();
    // Cached: no second read inside the refresh window.
    await fidoMds.listModels();
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('a blob that fails verification is not trusted — MDS reports unavailable', async () => {
    mockVerifyMDSBlob.mockRejectedValue(new Error('BLOB certificate path could not be validated'));
    expect(await fidoMds.lookupModel(YUBIKEY)).toBeNull();
    expect(mockIncCounter).toHaveBeenCalledWith('platform_fido_mds_loads_total', { outcome: 'failure', source: 'file' });
    expect(mockInitialize).not.toHaveBeenCalled();
  });
});
