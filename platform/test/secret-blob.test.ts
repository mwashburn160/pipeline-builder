// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the secret-blob wrap/unwrap helpers — the single source of
 * truth that replaced the near-identical JSON-around-EncryptedBlob
 * implementations across organization-service, org-idp-service,
 * and secret-reencrypt.
 *
 * The actual crypto path is mocked here — we only validate the JSON
 * envelope / shape-check behaviour, not the cipher itself (the cipher
 * has its own tests in api-core/test/secret-encryption.test.ts).
 */

jest.mock('@pipeline-builder/api-core', () => {
  return {
    encryptSecret: jest.fn((plaintext: string, orgId: string) => ({
      v: 1,
      keyId: 'env',
      orgId,
      ciphertext: Buffer.from(plaintext).toString('base64'),
      iv: 'iv-bytes',
      tag: 'tag-bytes',
      alg: 'aes-256-gcm',
    })),
    decryptSecret: jest.fn((blob: { ciphertext: string }) =>
      Buffer.from(blob.ciphertext, 'base64').toString('utf8'),
    ),
    isEncryptedBlob: jest.fn(
      (value: unknown): boolean =>
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { ciphertext?: unknown }).ciphertext === 'string',
    ),
  };
});

import { looksEncrypted, unwrapEncrypted, wrapEncrypted } from '../src/utils/secret-blob';

describe('secret-blob', () => {
  describe('looksEncrypted', () => {
    it('returns true for JSON-looking strings', () => {
      expect(looksEncrypted('{"ciphertext":"x"}')).toBe(true);
      expect(looksEncrypted('{')).toBe(true);
    });

    it('returns false for plain strings', () => {
      expect(looksEncrypted('plain')).toBe(false);
      expect(looksEncrypted('hello world')).toBe(false);
      expect(looksEncrypted('')).toBe(false);
    });

    it('returns false for non-string inputs', () => {
      // Type-cast to bypass TS — real callers may receive any
      expect(looksEncrypted(null as unknown as string)).toBe(false);
      expect(looksEncrypted(undefined as unknown as string)).toBe(false);
      expect(looksEncrypted(42 as unknown as string)).toBe(false);
    });
  });

  describe('wrap + unwrap roundtrip', () => {
    it('preserves plaintext through wrap → unwrap', () => {
      const plaintext = 'super-secret-api-key';
      const orgId = 'org-1';

      const wrapped = wrapEncrypted(plaintext, orgId);

      // Result should be a JSON-encoded EncryptedBlob
      expect(typeof wrapped).toBe('string');
      expect(looksEncrypted(wrapped)).toBe(true);
      const parsed = JSON.parse(wrapped);
      expect(parsed.ciphertext).toBeDefined();

      const unwrapped = unwrapEncrypted(wrapped, orgId, 'apiKey');
      expect(unwrapped).toBe(plaintext);
    });

    it('handles empty plaintext', () => {
      const wrapped = wrapEncrypted('', 'org-1');
      expect(unwrapEncrypted(wrapped, 'org-1', 'field')).toBe('');
    });
  });

  describe('unwrapEncrypted error cases', () => {
    it('throws when the raw string is not JSON-shaped', () => {
      expect(() => unwrapEncrypted('plain-text', 'org-1', 'apiKey')).toThrow(
        /not a JSON-encoded EncryptedBlob/,
      );
    });

    it('throws on JSON-shaped input that does not parse', () => {
      // Starts with '{' so looksEncrypted is true, but JSON.parse fails
      expect(() => unwrapEncrypted('{not-json', 'org-1', 'apiKey')).toThrow(
        /not valid JSON/,
      );
    });

    it('throws on valid JSON that is not an EncryptedBlob shape', () => {
      expect(() =>
        unwrapEncrypted('{"foo":"bar"}', 'org-1', 'apiKey'),
      ).toThrow(/does not match the EncryptedBlob shape/);
    });

    it('includes the fieldLabel in error messages', () => {
      expect(() =>
        unwrapEncrypted('cleartext', 'org-1', 'ssoClientSecret'),
      ).toThrow(/"ssoClientSecret"/);
    });
  });
});
