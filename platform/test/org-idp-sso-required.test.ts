// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The "SSO required" invariants and the test-result bookkeeping on the IdP
 * config (services/org-idp-service.ts):
 *   - switching "SSO required" ON needs an ENABLED IdP and a SUCCESSFUL test of
 *     the CURRENT settings on the CURRENT protocol; turning it off never needs one;
 *   - any connection-affecting change clears the last test result, so a success
 *     can never vouch for settings nobody tested;
 *   - an edit that re-sends the SAME client secret does not count as a change
 *     (the ciphertext is kept), while a new secret does;
 *   - a test result is recorded only while the config is still the one tested.
 */

import { randomBytes } from 'crypto';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { resetDefaultKeyProvider } from '@pipeline-builder/api-core';

const mockFindOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUpdateOne = jest.fn<(...a: unknown[]) => Promise<{ modifiedCount: number }>>();

jest.unstable_mockModule('../src/models/org-idp-config.js', () => ({
  __esModule: true,
  default: {
    findOne: (...a: unknown[]) => mockFindOne(...a),
    updateOne: (...a: unknown[]) => mockUpdateOne(...a),
  },
}));

process.env.SECRET_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const { orgIdpService } = await import('../src/services/org-idp-service.js');
const { wrapEncrypted } = await import('../src/utils/secret-blob.js');
const { IDP_SSO_REQUIRED_UNTESTED } = await import('../src/services/idp-mapping-errors.js');

const PASSED = { at: new Date('2026-09-01'), ok: true, protocol: 'saml' as const, actorId: 'admin-1' };

/** A stored SAML config document with a `save` spy. */
function samlDoc(over: Record<string, unknown> = {}) {
  const doc: Record<string, unknown> = {
    orgId: 'org-1',
    protocol: 'saml',
    samlEntityId: 'https://idp.test',
    samlSsoUrl: 'https://idp.test/sso',
    samlCertificates: ['CERT-A'],
    samlSignAuthnRequests: false,
    samlEncryptAssertions: false,
    allowedEmailDomains: [],
    enabled: true,
    ssoRequired: false,
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
  doc.save = jest.fn(async () => doc);
  return doc;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetDefaultKeyProvider();
});

describe('switching "SSO required" on', () => {
  it('is refused with no test result on file', async () => {
    mockFindOne.mockResolvedValue(samlDoc());
    await expect(orgIdpService.patch('org-1', 'admin-1', { ssoRequired: true })).rejects.toThrow(IDP_SSO_REQUIRED_UNTESTED);
  });

  it('is refused after a FAILED test', async () => {
    mockFindOne.mockResolvedValue(samlDoc({ lastTest: { ...PASSED, ok: false, reason: 'invalid_assertion' } }));
    await expect(orgIdpService.patch('org-1', 'admin-1', { ssoRequired: true })).rejects.toThrow(IDP_SSO_REQUIRED_UNTESTED);
  });

  it('is refused while the IdP is disabled', async () => {
    mockFindOne.mockResolvedValue(samlDoc({ enabled: false, lastTest: PASSED }));
    await expect(orgIdpService.patch('org-1', 'admin-1', { ssoRequired: true })).rejects.toThrow(IDP_SSO_REQUIRED_UNTESTED);
  });

  it('is refused when the passing test was for the OTHER protocol', async () => {
    mockFindOne.mockResolvedValue(samlDoc({ lastTest: { ...PASSED, protocol: 'oidc' } }));
    await expect(orgIdpService.patch('org-1', 'admin-1', { ssoRequired: true })).rejects.toThrow(IDP_SSO_REQUIRED_UNTESTED);
  });

  it('is refused when the same write changes the connection (which voids the test)', async () => {
    mockFindOne.mockResolvedValue(samlDoc({ lastTest: PASSED }));
    await expect(orgIdpService.patch('org-1', 'admin-1', { ssoRequired: true, samlCertificates: ['CERT-B'] }))
      .rejects.toThrow(IDP_SSO_REQUIRED_UNTESTED);
  });

  it('is accepted once enabled and tested, in the same write as enabling', async () => {
    const doc = samlDoc({ enabled: false, lastTest: PASSED });
    mockFindOne.mockResolvedValue(doc);
    const dto = await orgIdpService.patch('org-1', 'admin-1', { enabled: true, ssoRequired: true });
    expect(dto).toMatchObject({ enabled: true, ssoRequired: true, lastTest: { ok: true, protocol: 'saml' } });
  });

  it('can always be switched OFF, tested or not', async () => {
    mockFindOne.mockResolvedValue(samlDoc({ ssoRequired: true }));
    await expect(orgIdpService.patch('org-1', 'admin-1', { ssoRequired: false })).resolves.toMatchObject({ ssoRequired: false });
  });
});

describe('last test result', () => {
  it('is cleared by a connection change (certificates, endpoints, signing/encryption switches)', async () => {
    for (const change of [
      { samlCertificates: ['CERT-B'] },
      { samlSsoUrl: 'https://idp.test/other' },
      { samlEntityId: 'https://other-idp.test' },
      { samlEncryptAssertions: true },
      { samlSignAuthnRequests: true },
      { protocol: 'oidc' as const, provider: 'generic-oidc' as const, clientId: 'c', clientSecret: 's' },
    ]) {
      const doc = samlDoc({ lastTest: PASSED });
      mockFindOne.mockResolvedValue(doc);
      const dto = await orgIdpService.patch('org-1', 'admin-1', change);
      expect(dto?.lastTest).toBeUndefined();
    }
  });

  it('survives a change that does not affect the connection (attributes, SLO URL, the policy itself)', async () => {
    const doc = samlDoc({ lastTest: PASSED });
    mockFindOne.mockResolvedValue(doc);
    const dto = await orgIdpService.patch('org-1', 'admin-1', {
      samlAttributes: { email: 'mail' },
      samlSloUrl: 'https://idp.test/slo',
    });
    expect(dto?.lastTest).toMatchObject({ ok: true });
    expect(dto?.samlSloUrl).toBe('https://idp.test/slo');
  });

  it('survives an OIDC edit that re-sends the SAME client secret, but not a new one', async () => {
    const blob = await wrapEncrypted('the-secret', 'org-1');
    const oidc = (over: Record<string, unknown> = {}) => samlDoc({
      protocol: 'oidc',
      provider: 'generic-oidc',
      clientId: 'cid',
      clientSecretEncrypted: blob,
      discoveryUrl: 'https://idp.test/.well-known/openid-configuration',
      lastTest: { ...PASSED, protocol: 'oidc' },
      ...over,
    });

    const same = oidc();
    mockFindOne.mockResolvedValue(same);
    const kept = await orgIdpService.patch('org-1', 'admin-1', { clientSecret: 'the-secret' });
    expect(same.clientSecretEncrypted).toBe(blob);
    expect(kept?.lastTest).toMatchObject({ ok: true });

    const rotated = oidc();
    mockFindOne.mockResolvedValue(rotated);
    const cleared = await orgIdpService.patch('org-1', 'admin-1', { clientSecret: 'a-new-secret' });
    expect(rotated.clientSecretEncrypted).not.toBe(blob);
    expect(cleared?.lastTest).toBeUndefined();
  });
});

describe('recordTestResult', () => {
  it('records only against the config version that was tested, without bumping updatedAt', async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    const recorded = await orgIdpService.recordTestResult('org-1', '2026-09-01T00:00:00.000Z', PASSED);
    expect(recorded).toBe(true);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { orgId: 'org-1', updatedAt: new Date('2026-09-01T00:00:00.000Z'), protocol: 'saml' },
      { $set: { lastTest: PASSED } },
      { timestamps: false },
    );
  });

  it('reports false when the config changed mid-test', async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(orgIdpService.recordTestResult('org-1', '2026-09-01T00:00:00.000Z', PASSED)).resolves.toBe(false);
  });
});
