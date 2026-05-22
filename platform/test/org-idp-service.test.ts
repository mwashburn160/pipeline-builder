// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  scaffolding-level tests for the OrgIdpService.
 * Validates: secret encryption-or-passthrough, DTO sanitization (no
 * plaintext crosses the wire), upsert idempotency.
 */

import { randomBytes } from 'crypto';
import { encryptSecret, resetDefaultKeyProvider } from '@pipeline-builder/api-core';

const mockSave = jest.fn();
const mockCreate = jest.fn();
const mockFindOne = jest.fn();
const mockFind = jest.fn();
const mockDeleteOne = jest.fn();

jest.mock('../src/models/org-idp-config', () => ({
  __esModule: true,
  default: {
    findOne: mockFindOne,
    find: mockFind,
    create: mockCreate,
    deleteOne: mockDeleteOne,
  },
}));

// We exercise the REAL secret-encryption helper here; SECRET_ENCRYPTION_KEY
// is set per-test so encryptIfConfigured produces real ciphertext rather
// than the dev fallback (clear text). That way the DTO masking is meaningful.
const ORIGINAL_KEY = process.env.SECRET_ENCRYPTION_KEY;
beforeEach(() => {
  process.env.SECRET_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  jest.clearAllMocks();
  // Reset the lazy default provider so a key change between tests takes effect.
  resetDefaultKeyProvider();
});
afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
  else process.env.SECRET_ENCRYPTION_KEY = ORIGINAL_KEY;
});

import { orgIdpService } from '../src/services/org-idp-service';

describe('OrgIdpService.upsert', () => {
  it('creates a fresh config when none exists, encrypting the secret', async () => {
    mockFindOne.mockResolvedValue(null);
    let storedSecret = '';
    mockCreate.mockImplementation(async (doc: { clientSecretEncrypted: string; updatedAt?: Date }) => {
      storedSecret = doc.clientSecretEncrypted;
      return { ...doc, updatedAt: new Date('2026-01-01') } as never;
    });

    const dto = await orgIdpService.upsert('admin-1', {
      orgId: 'org-acme',
      provider: 'generic-oidc',
      clientId: 'client-xyz',
      clientSecret: 'super-secret-value',
      discoveryUrl: 'https://idp.acme.com/.well-known/openid-configuration',
      allowedEmailDomains: ['acme.com'],
    });

    // DTO must never expose the plaintext.
    expect(dto.hasClientSecret).toBe(true);
    expect(JSON.stringify(dto)).not.toContain('super-secret-value');
    // The encrypted blob in storage is JSON-serialized + does NOT contain the plaintext.
    expect(storedSecret).not.toContain('super-secret-value');
    expect(storedSecret.startsWith('{"alg":"aes-256-gcm-v1"')).toBe(true);
  });

  it('updates an existing config in-place (idempotent re-register)', async () => {
    const existing = {
      orgId: 'org-acme',
      provider: 'generic-oidc',
      clientId: 'old-client',
      clientSecretEncrypted: 'old-cipher',
      discoveryUrl: 'old-url',
      allowedEmailDomains: [],
      enabled: true,
      createdBy: 'orig',
      updatedBy: 'orig',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      save: mockSave,
    };
    mockFindOne.mockResolvedValue(existing);
    mockSave.mockImplementation(async function (this: typeof existing) {
      this.updatedAt = new Date();
      return this as never;
    });

    const dto = await orgIdpService.upsert('admin-2', {
      orgId: 'org-acme',
      provider: 'generic-oidc',
      clientId: 'new-client',
      clientSecret: 'new-secret',
      discoveryUrl: 'new-url',
    });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(existing.clientId).toBe('new-client');
    expect(existing.discoveryUrl).toBe('new-url');
    expect(existing.updatedBy).toBe('admin-2');
    expect(dto.hasClientSecret).toBe(true);
  });
});

describe('OrgIdpService.patch', () => {
  it('leaves the existing secret intact when no new secret is supplied', async () => {
    const existing = {
      orgId: 'org-acme',
      provider: 'generic-oidc',
      clientId: 'client-x',
      clientSecretEncrypted: 'existing-cipher',
      discoveryUrl: 'url',
      allowedEmailDomains: [],
      enabled: true,
      createdBy: 'a',
      updatedBy: 'a',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      save: mockSave,
    };
    mockFindOne.mockResolvedValue(existing);
    mockSave.mockImplementation(async function (this: typeof existing) { return this as never; });

    await orgIdpService.patch('org-acme', 'admin', { enabled: false });

    expect(existing.clientSecretEncrypted).toBe('existing-cipher');
    expect(existing.enabled).toBe(false);
  });

  it('replaces the secret when one is supplied', async () => {
    const existing = {
      orgId: 'org-acme',
      provider: 'generic-oidc',
      clientId: 'client-x',
      clientSecretEncrypted: 'old',
      discoveryUrl: 'url',
      allowedEmailDomains: [],
      enabled: true,
      createdBy: 'a',
      updatedBy: 'a',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      save: mockSave,
    };
    mockFindOne.mockResolvedValue(existing);
    mockSave.mockImplementation(async function (this: typeof existing) { return this as never; });

    await orgIdpService.patch('org-acme', 'admin', { clientSecret: 'rotated' });

    expect(existing.clientSecretEncrypted).not.toBe('old');
    expect(existing.clientSecretEncrypted.startsWith('{"alg":"aes-256-gcm-v1"')).toBe(true);
  });

  it('returns null when the org has no config', async () => {
    mockFindOne.mockResolvedValue(null);
    const result = await orgIdpService.patch('org-missing', 'admin', { enabled: false });
    expect(result).toBeNull();
  });
});

describe('OrgIdpService.getDecryptedSecret', () => {
  it('round-trips through encryptIfConfigured -> decryptIfBlob', async () => {
    // First, encrypt a secret the same way the service would.
    const blob = encryptSecret('the-real-secret', 'org-acme');
    const stored = JSON.stringify(blob);

    mockFindOne.mockReturnValue({ select: () => Promise.resolve({ clientSecretEncrypted: stored }) });

    const plain = await orgIdpService.getDecryptedSecret('org-acme');
    expect(plain).toBe('the-real-secret');
  });

  it('returns null when no config exists', async () => {
    mockFindOne.mockReturnValue({ select: () => Promise.resolve(null) });
    expect(await orgIdpService.getDecryptedSecret('org-missing')).toBeNull();
  });

  it('throws on a malformed stored value (legacy clear-text fallback removed)', async () => {
    // The permissive clear-text fallback was removed alongside the
    // mandatory-encryption cutover. The startup backfill re-encrypts
    // pre-encryption rows; reaching this throw means a row escaped the
    // backfill and needs manual repair.
    mockFindOne.mockReturnValue({ select: () => Promise.resolve({ clientSecretEncrypted: 'legacy-clear-text' }) });
    await expect(orgIdpService.getDecryptedSecret('org-acme'))
      .rejects.toThrow(/not a JSON-encoded EncryptedBlob/);
  });
});
