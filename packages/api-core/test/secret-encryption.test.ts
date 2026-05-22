// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  Tests for the secret-encryption primitive. Cover the round-trip,
 * the per-org key binding, the auth-tag tamper check, and the env validation.
 */

import { randomBytes } from 'crypto';
import { decryptSecret, encryptSecret, EnvKeyProvider, isEncryptedBlob, resetDefaultKeyProvider } from '../src/utils/secret-encryption';

// Each test gets a fresh, valid env so we don't leak state across cases.
const ORIGINAL_ENV = process.env.SECRET_ENCRYPTION_KEY;
beforeEach(() => {
  process.env.SECRET_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  resetDefaultKeyProvider();
});
afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
  else process.env.SECRET_ENCRYPTION_KEY = ORIGINAL_ENV;
  resetDefaultKeyProvider();
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a plaintext through encrypt -> decrypt', () => {
    const blob = encryptSecret('sk-anthropic-secret-key-12345', 'org-acme');
    expect(blob.alg).toBe('aes-256-gcm-v1');
    expect(typeof blob.iv).toBe('string');
    expect(typeof blob.ciphertext).toBe('string');
    expect(decryptSecret(blob, 'org-acme')).toBe('sk-anthropic-secret-key-12345');
  });

  it('produces a different ciphertext on every encrypt (random IV)', () => {
    const a = encryptSecret('same-secret', 'org-acme');
    const b = encryptSecret('same-secret', 'org-acme');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // Both still decrypt to the same plaintext.
    expect(decryptSecret(a, 'org-acme')).toBe('same-secret');
    expect(decryptSecret(b, 'org-acme')).toBe('same-secret');
  });

  it('binds the key to orgId  a different org cannot decrypt', () => {
    const blob = encryptSecret('sk-secret', 'org-acme');
    expect(() => decryptSecret(blob, 'org-other')).toThrow();
  });

  it('refuses to encrypt an empty string', () => {
    expect(() => encryptSecret('', 'org-acme')).toThrow(/empty string/i);
  });

  it('refuses to decrypt an unknown alg (forces explicit migration on format change)', () => {
    const blob = encryptSecret('hello', 'org-acme');
    expect(() => decryptSecret({ ...blob, alg: 'aes-128-gcm-v0' as never }, 'org-acme')).toThrow(/Unsupported encryption alg/);
  });

  it('detects ciphertext tampering via the GCM auth tag', () => {
    const blob = encryptSecret('hello', 'org-acme');
    // Change one byte in the ciphertext; auth tag check must reject. We
    // use modular arithmetic instead of XOR so the eslint no-bitwise rule
    // doesn't complain  same effect (predictable byte mutation).
    const buf = Buffer.from(blob.ciphertext, 'base64');
    buf[0] = (buf[0] + 1) % 256;
    const tampered = { ...blob, ciphertext: buf.toString('base64') };
    expect(() => decryptSecret(tampered, 'org-acme')).toThrow();
  });
});

describe('EnvKeyProvider', () => {
  it('throws when SECRET_ENCRYPTION_KEY is unset', () => {
    delete process.env.SECRET_ENCRYPTION_KEY;
    expect(() => new EnvKeyProvider()).toThrow(/SECRET_ENCRYPTION_KEY env is required/);
  });

  it('throws when the key is the wrong length', () => {
    process.env.SECRET_ENCRYPTION_KEY = 'too-short';
    expect(() => new EnvKeyProvider()).toThrow(/must decode to 32 bytes/);
  });

  it('accepts hex- or base64-encoded 32-byte keys', () => {
    const raw = randomBytes(32);
    expect(() => new EnvKeyProvider(raw.toString('hex'))).not.toThrow();
    expect(() => new EnvKeyProvider(raw.toString('base64'))).not.toThrow();
  });

  it('derives different keys for different orgIds (HKDF binding)', () => {
    const provider = new EnvKeyProvider(randomBytes(32).toString('hex'));
    const a = provider.deriveKey('org-a');
    const b = provider.deriveKey('org-b');
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});

describe('KmsKeyProvider', () => {
  // Stub `@aws-sdk/client-kms` so the test doesn't reach real AWS. The
  // dynamic import inside `fetchAndDecrypt` resolves via node's module
  // cache; setting the cache entry here intercepts it.
  const mockSend = jest.fn();
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@aws-sdk/client-kms', () => ({
      KMSClient: jest.fn(() => ({ send: mockSend })),
      DecryptCommand: jest.fn((args) => ({ __cmd: 'Decrypt', args })),
    }));
    mockSend.mockReset();
  });
  afterEach(() => {
    jest.dontMock('@aws-sdk/client-kms');
  });

  it('refuses to construct without the required env vars', async () => {
    delete process.env.SECRET_ENCRYPTION_KMS_KEY_ID;
    delete process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT;
    const { KmsKeyProvider: K } = await import('../src/utils/secret-encryption');
    expect(() => new K()).toThrow(/SECRET_ENCRYPTION_KMS_KEY_ID/);

    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    expect(() => new K()).toThrow(/SECRET_ENCRYPTION_KMS_CIPHERTEXT/);
  });

  it('throws on deriveKey before warmup (fail-fast on misconfig)', async () => {
    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT = Buffer.from('opaque-blob').toString('base64');
    const { KmsKeyProvider: K } = await import('../src/utils/secret-encryption');
    const p = new K();
    expect(() => p.deriveKey('acme')).toThrow(/not warmed up/);
  });

  it('warmup decrypts via KMS and caches the master key', async () => {
    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT = Buffer.from('opaque').toString('base64');
    const master = randomBytes(32);
    mockSend.mockResolvedValueOnce({ Plaintext: master });

    const { KmsKeyProvider: K, encryptSecret: enc, decryptSecret: dec } = await import('../src/utils/secret-encryption');
    const p = new K();
    await p.warmup();
    // After warmup, deriveKey is sync.
    const k = p.deriveKey('acme');
    expect(k.length).toBe(32);
    // The provider behaves identically to EnvKeyProvider on the
    // encrypt/decrypt round-trip  proves the KMS-recovered master is
    // wired correctly into HKDF.
    const blob = enc('hello-kms', 'acme', p);
    expect(dec(blob, 'acme', p)).toBe('hello-kms');
  });

  it('rejects KMS responses with the wrong key length', async () => {
    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT = Buffer.from('opaque').toString('base64');
    mockSend.mockResolvedValueOnce({ Plaintext: Buffer.from('too-short') });
    const { KmsKeyProvider: K } = await import('../src/utils/secret-encryption');
    const p = new K();
    await expect(p.warmup()).rejects.toThrow(/expected 32/);
  });

  it('rejects KMS responses with no plaintext', async () => {
    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT = Buffer.from('opaque').toString('base64');
    mockSend.mockResolvedValueOnce({});
    const { KmsKeyProvider: K } = await import('../src/utils/secret-encryption');
    const p = new K();
    await expect(p.warmup()).rejects.toThrow(/empty Plaintext/);
  });

  it('coalesces concurrent warmup calls into one KMS request', async () => {
    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT = Buffer.from('opaque').toString('base64');
    const master = randomBytes(32);
    mockSend.mockResolvedValueOnce({ Plaintext: master });

    const { KmsKeyProvider: K } = await import('../src/utils/secret-encryption');
    const p = new K();
    await Promise.all([p.warmup(), p.warmup(), p.warmup()]);
    // Even with three concurrent callers, KMS Decrypt fires exactly once
    //  the in-flight promise is shared.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('subsequent warmup calls after success are no-ops (cached)', async () => {
    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT = Buffer.from('opaque').toString('base64');
    const master = randomBytes(32);
    mockSend.mockResolvedValueOnce({ Plaintext: master });

    const { KmsKeyProvider: K } = await import('../src/utils/secret-encryption');
    const p = new K();
    await p.warmup();
    await p.warmup(); // second call should not re-hit KMS
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('PerOrgKmsKeyProvider', () => {
  // Mock @aws-sdk/client-kms the same way KmsKeyProvider tests do — the
  // provider does a dynamic `import('@aws-sdk/client-kms')` so jest's
  // module cache is what intercepts.
  const mockSend = jest.fn();
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@aws-sdk/client-kms', () => ({
      KMSClient: jest.fn(() => ({ send: mockSend })),
      DecryptCommand: jest.fn((args) => ({ __cmd: 'Decrypt', args })),
    }));
    mockSend.mockReset();
  });
  afterEach(() => {
    jest.dontMock('@aws-sdk/client-kms');
  });

  it('falls back to the fallback provider for orgs without per-org config', async () => {
    const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E, encryptSecret: enc, decryptSecret: dec } = await import('../src/utils/secret-encryption');
    const fallback = new E(randomBytes(32).toString('hex'));
    const provider = new P({ resolver: async () => null, fallback });

    // No per-org config → resolver returns null → provider uses fallback's HKDF.
    // The same plaintext encrypted under `provider` and `fallback` must produce
    // the same derived key (different IV → different ciphertext, but both
    // decrypt successfully under either provider).
    const blob = enc('hello', 'org-x', provider);
    expect(blob.kid).toBeUndefined();
    expect(dec(blob, 'org-x', fallback)).toBe('hello');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('uses per-org HKDF-derived key after warmup; embeds kid in blob', async () => {
    const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E, encryptSecret: enc, decryptSecret: dec } = await import('../src/utils/secret-encryption');
    const master = randomBytes(32);
    mockSend.mockResolvedValueOnce({ Plaintext: master });

    const fallback = new E(randomBytes(32).toString('hex'));
    const provider = new P({
      resolver: async () => ({ keyId: 'alias/org-acme', ciphertextBase64: Buffer.from('opaque').toString('base64') }),
      fallback,
    });
    await provider.deriveKeyAsync('org-acme');

    const blob = enc('per-org-secret', 'org-acme', provider);
    expect(blob.kid).toBe('alias/org-acme');
    expect(dec(blob, 'org-acme', provider)).toBe('per-org-secret');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('rejects a blob whose kid does not match the current provider config', async () => {
    const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E, encryptSecret: enc, decryptSecret: dec } = await import('../src/utils/secret-encryption');
    const master = randomBytes(32);
    mockSend.mockResolvedValue({ Plaintext: master });

    const fallback = new E(randomBytes(32).toString('hex'));
    const provider = new P({
      resolver: async () => ({ keyId: 'alias/v1', ciphertextBase64: Buffer.from('opaque').toString('base64') }),
      fallback,
    });
    await provider.deriveKeyAsync('org-acme');
    const blob = enc('hello', 'org-acme', provider);
    expect(blob.kid).toBe('alias/v1');

    // Simulate operator rotating to a new CMK — fresh provider with same
    // master bytes but a different keyId. The stored blob's `kid` no longer
    // matches → decrypt fails loud instead of throwing an opaque auth-tag error.
    const rotated = new P({
      resolver: async () => ({ keyId: 'alias/v2', ciphertextBase64: Buffer.from('opaque').toString('base64') }),
      fallback,
    });
    await rotated.deriveKeyAsync('org-acme');
    expect(() => dec(blob, 'org-acme', rotated)).toThrow(/KMS key id mismatch/);
  });

  it('coalesces concurrent warmup calls for the same org into one KMS Decrypt', async () => {
    const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E } = await import('../src/utils/secret-encryption');
    const master = randomBytes(32);
    // Delay the resolver so all three callers queue on the in-flight promise.
    mockSend.mockImplementationOnce(() => new Promise((r) => setTimeout(() => r({ Plaintext: master }), 10)));

    const fallback = new E(randomBytes(32).toString('hex'));
    const provider = new P({
      resolver: async () => ({ keyId: 'alias/org-acme', ciphertextBase64: Buffer.from('opaque').toString('base64') }),
      fallback,
    });
    await Promise.all([
      provider.deriveKeyAsync('org-acme'),
      provider.deriveKeyAsync('org-acme'),
      provider.deriveKeyAsync('org-acme'),
    ]);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('uses independent per-org keys (two orgs cannot decrypt each other)', async () => {
    const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E, encryptSecret: enc, decryptSecret: dec } = await import('../src/utils/secret-encryption');
    const masterA = randomBytes(32);
    const masterB = randomBytes(32);
    mockSend.mockResolvedValueOnce({ Plaintext: masterA });
    mockSend.mockResolvedValueOnce({ Plaintext: masterB });

    const fallback = new E(randomBytes(32).toString('hex'));
    const provider = new P({
      resolver: async (orgId) => orgId === 'org-a'
        ? { keyId: 'alias/a', ciphertextBase64: Buffer.from('opaque-a').toString('base64') }
        : { keyId: 'alias/b', ciphertextBase64: Buffer.from('opaque-b').toString('base64') },
      fallback,
    });
    await provider.deriveKeyAsync('org-a');
    await provider.deriveKeyAsync('org-b');

    const blobA = enc('secret-a', 'org-a', provider);
    // Decrypting org-a's blob as org-b fails both the kid check (different
    // kids) and the underlying HKDF binding — kid mismatch fires first.
    expect(() => dec(blobA, 'org-b', provider)).toThrow();
  });

  it('evict() drops the cached master so the next touch re-fetches from KMS', async () => {
    const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E } = await import('../src/utils/secret-encryption');
    const master1 = randomBytes(32);
    const master2 = randomBytes(32);
    mockSend.mockResolvedValueOnce({ Plaintext: master1 });
    mockSend.mockResolvedValueOnce({ Plaintext: master2 });

    const fallback = new E(randomBytes(32).toString('hex'));
    const provider = new P({
      resolver: async () => ({ keyId: 'alias/org-acme', ciphertextBase64: Buffer.from('opaque').toString('base64') }),
      fallback,
    });
    await provider.deriveKeyAsync('org-acme');
    expect(mockSend).toHaveBeenCalledTimes(1);

    // No evict → second call is a no-op cache hit.
    await provider.deriveKeyAsync('org-acme');
    expect(mockSend).toHaveBeenCalledTimes(1);

    provider.evict('org-acme');
    await provider.deriveKeyAsync('org-acme');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe('isEncryptedBlob', () => {
  it('returns true for an actual blob', () => {
    expect(isEncryptedBlob(encryptSecret('x', 'org'))).toBe(true);
  });

  it('returns false for plaintext / non-blob shapes', () => {
    expect(isEncryptedBlob('clear-text')).toBe(false);
    expect(isEncryptedBlob({ alg: 'wrong', iv: 'a', ciphertext: 'b' })).toBe(false);
    expect(isEncryptedBlob({ alg: 'aes-256-gcm-v1' })).toBe(false);
    expect(isEncryptedBlob(null)).toBe(false);
    expect(isEncryptedBlob(undefined)).toBe(false);
  });
});
