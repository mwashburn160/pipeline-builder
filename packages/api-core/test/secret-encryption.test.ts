// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'crypto';
import { jest, describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import type { AnyFn } from '../src/testing/any-fn.js';

/**
 *  Tests for the secret-encryption primitive. Cover the round-trip,
 * the per-org key binding, the auth-tag tamper check, and the env validation.
 */

import { decryptSecret, encryptSecret, EnvKeyProvider, isEncryptedBlob, resetDefaultKeyProvider } from '../src/utils/secret-encryption.js';

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
  it('round-trips a plaintext through encrypt -> decrypt', async () => {
    const blob = await encryptSecret('sk-anthropic-secret-key-12345', 'org-acme');
    expect(blob.alg).toBe('aes-256-gcm-v1');
    expect(typeof blob.iv).toBe('string');
    expect(typeof blob.ciphertext).toBe('string');
    expect(await decryptSecret(blob, 'org-acme')).toBe('sk-anthropic-secret-key-12345');
  });

  it('produces a different ciphertext on every encrypt (random IV)', async () => {
    const a = await encryptSecret('same-secret', 'org-acme');
    const b = await encryptSecret('same-secret', 'org-acme');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // Both still decrypt to the same plaintext.
    expect(await decryptSecret(a, 'org-acme')).toBe('same-secret');
    expect(await decryptSecret(b, 'org-acme')).toBe('same-secret');
  });

  it('binds the key to orgId  a different org cannot decrypt', async () => {
    const blob = await encryptSecret('sk-secret', 'org-acme');
    await expect(decryptSecret(blob, 'org-other')).rejects.toThrow();
  });

  it('derives the same key whatever the casing or padding of the org id', async () => {
    // The org id is the HKDF salt; a route that passed an un-normalised id
    // (an admin URL with upper-case hex) used to write a secret that the
    // lower-case read path could never open.
    const upper = await encryptSecret('sso-client-secret', '  65A1B2C3D4E5F6A7B8C9D0E1  ');
    expect(await decryptSecret(upper, '65a1b2c3d4e5f6a7b8c9d0e1')).toBe('sso-client-secret');
    const lower = await encryptSecret('sso-client-secret', '65a1b2c3d4e5f6a7b8c9d0e1');
    expect(await decryptSecret(lower, '65A1B2C3D4E5F6A7B8C9D0E1')).toBe('sso-client-secret');
  });

  it('still opens a blob written under an already lower-case scope (no re-encryption needed)', async () => {
    const provider = new EnvKeyProvider();
    for (const scope of ['65a1b2c3d4e5f6a7b8c9d0e1', '000000000000000000000001', 'user:65a1b2c3d4e5f6a7b8c9d0e1', 'saml-sp-keys']) {
      const blob = await encryptSecret('x', scope, provider);
      expect(await decryptSecret(blob, scope, provider, null)).toBe('x');
    }
  });

  it('refuses to encrypt an empty string', async () => {
    await expect(encryptSecret('', 'org-acme')).rejects.toThrow(/empty string/i);
  });

  it('refuses to decrypt an unknown alg (forces explicit migration on format change)', async () => {
    const blob = await encryptSecret('hello', 'org-acme');
    await expect(decryptSecret({ ...blob, alg: 'aes-128-gcm-v0' as never }, 'org-acme')).rejects.toThrow(/Unsupported encryption alg/);
  });

  it('detects ciphertext tampering via the GCM auth tag', async () => {
    const blob = await encryptSecret('hello', 'org-acme');
    // Change one byte in the ciphertext; auth tag check must reject. We
    // use modular arithmetic instead of XOR so the eslint no-bitwise rule
    // doesn't complain  same effect (predictable byte mutation).
    const buf = Buffer.from(blob.ciphertext, 'base64');
    buf[0] = (buf[0] + 1) % 256;
    const tampered = { ...blob, ciphertext: buf.toString('base64') };
    await expect(decryptSecret(tampered, 'org-acme')).rejects.toThrow();
  });
});

describe('EnvKeyProvider', () => {
  it('throws when SECRET_ENCRYPTION_KEY is unset', async () => {
    delete process.env.SECRET_ENCRYPTION_KEY;
    expect(() => new EnvKeyProvider()).toThrow(/SECRET_ENCRYPTION_KEY env is required/);
  });

  it('throws when the key is the wrong length', async () => {
    process.env.SECRET_ENCRYPTION_KEY = 'too-short';
    expect(() => new EnvKeyProvider()).toThrow(/must decode to 32 bytes/);
  });

  it('accepts hex- or base64-encoded 32-byte keys', async () => {
    const raw = randomBytes(32);
    expect(() => new EnvKeyProvider(raw.toString('hex'))).not.toThrow();
    expect(() => new EnvKeyProvider(raw.toString('base64'))).not.toThrow();
  });

  it('derives different keys for different orgIds (HKDF binding)', async () => {
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
  const mockSend = jest.fn<AnyFn>();
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
    const { KmsKeyProvider: K } = await import('../src/utils/secret-encryption.js');
    expect(() => new K()).toThrow(/SECRET_ENCRYPTION_KMS_KEY_ID/);

    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    expect(() => new K()).toThrow(/SECRET_ENCRYPTION_KMS_CIPHERTEXT/);
  });

  it('throws on deriveKey before warmup (fail-fast on misconfig)', async () => {
    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT = Buffer.from('opaque-blob').toString('base64');
    const { KmsKeyProvider: K } = await import('../src/utils/secret-encryption.js');
    const p = new K();
    expect(() => p.deriveKey('acme')).toThrow(/not warmed up/);
  });

  it('warmup decrypts via KMS and caches the master key', async () => {
    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT = Buffer.from('opaque').toString('base64');
    const master = randomBytes(32);
    mockSend.mockResolvedValueOnce({ Plaintext: master });

    const { KmsKeyProvider: K, encryptSecret: enc, decryptSecret: dec } = await import('../src/utils/secret-encryption.js');
    const p = new K();
    await p.warmup();
    // After warmup, deriveKey is sync.
    const k = p.deriveKey('acme');
    expect(k.length).toBe(32);
    // The provider behaves identically to EnvKeyProvider on the
    // encrypt/decrypt round-trip  proves the KMS-recovered master is
    // wired correctly into HKDF.
    const blob = await enc('hello-kms', 'acme', p);
    expect(await dec(blob, 'acme', p)).toBe('hello-kms');
  });

  it('rejects KMS responses with the wrong key length', async () => {
    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT = Buffer.from('opaque').toString('base64');
    mockSend.mockResolvedValueOnce({ Plaintext: Buffer.from('too-short') });
    const { KmsKeyProvider: K } = await import('../src/utils/secret-encryption.js');
    const p = new K();
    await expect(p.warmup()).rejects.toThrow(/expected 32/);
  });

  it('rejects KMS responses with no plaintext', async () => {
    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT = Buffer.from('opaque').toString('base64');
    mockSend.mockResolvedValueOnce({});
    const { KmsKeyProvider: K } = await import('../src/utils/secret-encryption.js');
    const p = new K();
    await expect(p.warmup()).rejects.toThrow(/empty Plaintext/);
  });

  it('coalesces concurrent warmup calls into one KMS request', async () => {
    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT = Buffer.from('opaque').toString('base64');
    const master = randomBytes(32);
    mockSend.mockResolvedValueOnce({ Plaintext: master });

    const { KmsKeyProvider: K } = await import('../src/utils/secret-encryption.js');
    const p = new K();
    await Promise.all([p.warmup(), p.warmup(), p.warmup()]);
    // Even with three concurrent callers, KMS Decrypt fires exactly once
    //  the in-flight promise is shared.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  /**
   * Rotation FROM a KMS master TO the env master: the primary is plaintext and
   * the outgoing master is still KMS-wrapped. `initSecretEncryption()` resolved
   * the fallback only on its KMS-primary path, so this direction never read
   * `SECRET_ENCRYPTION_KMS_CIPHERTEXT_PREVIOUS` at all — the lazy resolver knows
   * only the plaintext var — and every row still written under the old master
   * failed with an opaque auth-tag error.
   *
   * Reachable because the shared `KmsKeyProvider` has no `kidFor`, so the blobs
   * it wrote are kid-less and the retry path accepts them. (A PER-ORG KMS blob
   * carries a kid and is deliberately excluded: no shared previous master can
   * open it.)
   */
  it('decrypts under a KMS-wrapped PREVIOUS master when the primary is the env master', async () => {
    const oldMaster = randomBytes(32);
    process.env.SECRET_ENCRYPTION_KMS_KEY_ID_PREVIOUS = 'alias/outgoing';
    process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT_PREVIOUS = Buffer.from('wrapped-old').toString('base64');
    // No KMS PRIMARY — this is the env-master side of the rotation.
    delete process.env.SECRET_ENCRYPTION_KMS_KEY_ID;
    delete process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT;

    const mod = await import('../src/utils/secret-encryption.js');
    // A row written before the rotation, under the outgoing KMS master.
    mockSend.mockResolvedValueOnce({ Plaintext: oldMaster });
    const outgoing = new mod.KmsKeyProvider({ keyId: 'alias/outgoing', ciphertextBase64: Buffer.from('wrapped-old').toString('base64') });
    await outgoing.warmup();
    const blob = await mod.encryptSecret('sk-written-before-rotation', 'org-acme', outgoing);
    expect(blob.kid).toBeUndefined();

    // Boot the new configuration: env primary, KMS previous.
    mod.resetDefaultKeyProvider();
    process.env.SECRET_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    mockSend.mockResolvedValueOnce({ Plaintext: oldMaster });
    const { mode } = await mod.initSecretEncryption();
    expect(mode).toBe('env');

    // The primary cannot open it; the resolved previous can.
    expect(await mod.decryptSecret(blob, 'org-acme')).toBe('sk-written-before-rotation');

    delete process.env.SECRET_ENCRYPTION_KMS_KEY_ID_PREVIOUS;
    delete process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT_PREVIOUS;
    mod.resetDefaultKeyProvider();
  });

  it('subsequent warmup calls after success are no-ops (cached)', async () => {
    process.env.SECRET_ENCRYPTION_KMS_KEY_ID = 'alias/test';
    process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT = Buffer.from('opaque').toString('base64');
    const master = randomBytes(32);
    mockSend.mockResolvedValueOnce({ Plaintext: master });

    const { KmsKeyProvider: K } = await import('../src/utils/secret-encryption.js');
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
  const mockSend = jest.fn<AnyFn>();
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
    const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E, encryptSecret: enc, decryptSecret: dec } = await import('../src/utils/secret-encryption.js');
    const fallback = new E(randomBytes(32).toString('hex'));
    const provider = new P({ resolver: async () => null, fallback });

    // No per-org config → resolver returns null → provider uses fallback's HKDF.
    // The same plaintext encrypted under `provider` and `fallback` must produce
    // the same derived key (different IV → different ciphertext, but both
    // decrypt successfully under either provider).
    const blob = await enc('hello', 'org-x', provider);
    expect(blob.kid).toBeUndefined();
    expect(await dec(blob, 'org-x', fallback)).toBe('hello');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('uses per-org HKDF-derived key after warmup; embeds kid in blob', async () => {
    const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E, encryptSecret: enc, decryptSecret: dec } = await import('../src/utils/secret-encryption.js');
    const master = randomBytes(32);
    mockSend.mockResolvedValueOnce({ Plaintext: master });

    const fallback = new E(randomBytes(32).toString('hex'));
    const provider = new P({
      resolver: async () => ({ keyId: 'alias/org-acme', ciphertextBase64: Buffer.from('opaque').toString('base64') }),
      fallback,
    });
    await provider.deriveKeyAsync('org-acme');

    const blob = await enc('per-org-secret', 'org-acme', provider);
    expect(blob.kid).toBe('alias/org-acme');
    expect(await dec(blob, 'org-acme', provider)).toBe('per-org-secret');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('rejects a blob whose kid does not match the current provider config', async () => {
    const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E, encryptSecret: enc, decryptSecret: dec } = await import('../src/utils/secret-encryption.js');
    const master = randomBytes(32);
    mockSend.mockResolvedValue({ Plaintext: master });

    const fallback = new E(randomBytes(32).toString('hex'));
    const provider = new P({
      resolver: async () => ({ keyId: 'alias/v1', ciphertextBase64: Buffer.from('opaque').toString('base64') }),
      fallback,
    });
    await provider.deriveKeyAsync('org-acme');
    const blob = await enc('hello', 'org-acme', provider);
    expect(blob.kid).toBe('alias/v1');

    // Simulate operator rotating to a new CMK — fresh provider with same
    // master bytes but a different keyId. The stored blob's `kid` no longer
    // matches → decrypt fails loud instead of throwing an opaque auth-tag error.
    const rotated = new P({
      resolver: async () => ({ keyId: 'alias/v2', ciphertextBase64: Buffer.from('opaque').toString('base64') }),
      fallback,
    });
    await rotated.deriveKeyAsync('org-acme');
    await expect(dec(blob, 'org-acme', rotated)).rejects.toThrow(/KMS key id mismatch/);
  });

  it('coalesces concurrent warmup calls for the same org into one KMS Decrypt', async () => {
    const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E } = await import('../src/utils/secret-encryption.js');
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
    const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E, encryptSecret: enc, decryptSecret: dec } = await import('../src/utils/secret-encryption.js');
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

    const blobA = await enc('secret-a', 'org-a', provider);
    // Decrypting org-a's blob as org-b fails both the kid check (different
    // kids) and the underlying HKDF binding — kid mismatch fires first.
    await expect(dec(blobA, 'org-b', provider)).rejects.toThrow();
  });

  it('evict() drops the cached master so the next touch re-fetches from KMS', async () => {
    const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E } = await import('../src/utils/secret-encryption.js');
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

  it('REGRESSION: a failed warm-up rejects ONLY to its caller, never as an unhandled rejection', async () => {
    // The in-flight cleanup used to be `void promise.finally(...)`, whose derived
    // promise re-rejected with nobody listening; the crash handler turns an
    // unhandledRejection into process.exit(1), so one org's KMS outage
    // restart-looped every pod that served its secrets.
    const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E } = await import('../src/utils/secret-encryption.js');
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const provider = new P({
        resolver: async () => { throw new Error('db down'); },
        fallback: new E(randomBytes(32).toString('hex')),
      });
      await expect(provider.ensureWarmed('org-acme')).rejects.toThrow('db down');
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      // The failed attempt is not cached: the next call tries again.
      await expect(provider.ensureWarmed('org-acme')).rejects.toThrow('db down');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  /**
   * A per-org master cached on one replica must not outlive a KMS config change
   * made on another. The change broadcasts an eviction over the cache-invalidation
   * bus (Redis pub/sub), and every cached key also carries a bounded TTL as the
   * backstop for a missed or undeliverable broadcast.
   */
  describe('cross-replica eviction and the TTL backstop', () => {
    type Msg = { origin: string; prefix: string; op: 'del' | 'pattern' | 'clear'; key?: string };
    /** An in-memory bus: every publish reaches every subscriber, the publisher included (as Redis does). */
    const memoryBus = () => {
      const handlers: Array<{ onMessage: (m: Msg) => void; onResync: () => void }> = [];
      return {
        publish: jest.fn((m: Msg) => { for (const h of handlers) h.onMessage(m); }),
        subscribe: (onMessage: (m: Msg) => void, onResync: () => void) => { handlers.push({ onMessage, onResync }); },
        resync: () => { for (const h of handlers) h.onResync(); },
      };
    };
    const cfg = (keyId = 'alias/org-acme') => ({ keyId, ciphertextBase64: Buffer.from('opaque').toString('base64') });

    it('an eviction on one instance evicts the org on every other instance sharing the bus', async () => {
      const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E } = await import('../src/utils/secret-encryption.js');
      mockSend.mockImplementation(async () => ({ Plaintext: randomBytes(32) }));
      const bus = memoryBus();
      const fallback = new E(randomBytes(32).toString('hex'));
      let current = cfg('alias/old');
      const onEvictB = jest.fn();
      const a = new P({ resolver: async () => current, fallback, invalidationBus: bus });
      const b = new P({ resolver: async () => current, fallback, invalidationBus: bus, onEvict: onEvictB });
      await a.ensureWarmed('org-acme');
      await b.ensureWarmed('org-acme');
      expect(b.kidFor('org-acme')).toBe('alias/old');

      current = cfg('alias/new');
      a.evict('ORG-ACME');
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ op: 'del', key: 'org-acme' }));
      // B dropped its cached key (and its own config cache, via the hook)...
      expect(b.kidFor('org-acme')).toBeUndefined();
      expect(onEvictB).toHaveBeenCalledWith('org-acme');
      // ...so its next touch reads the NEW config.
      await b.ensureWarmed('org-acme');
      expect(b.kidFor('org-acme')).toBe('alias/new');
    });

    it('ignores another cache namespace on the shared bus, and clears everything on a resync', async () => {
      const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E } = await import('../src/utils/secret-encryption.js');
      mockSend.mockImplementation(async () => ({ Plaintext: randomBytes(32) }));
      const bus = memoryBus();
      const b = new P({ resolver: async () => cfg(), fallback: new E(randomBytes(32).toString('hex')), invalidationBus: bus });
      await b.ensureWarmed('org-acme');
      bus.publish({ origin: 'other', prefix: 'plugin:', op: 'del', key: 'org-acme' });
      expect(b.kidFor('org-acme')).toBe('alias/org-acme');
      // A (re)subscribe means broadcasts may have been missed.
      bus.resync();
      expect(b.kidFor('org-acme')).toBeUndefined();
    });

    it('an eviction that lands while a resolve is in flight does not let the stale answer be cached', async () => {
      const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E } = await import('../src/utils/secret-encryption.js');
      mockSend.mockImplementation(async () => ({ Plaintext: randomBytes(32) }));
      let release!: () => void;
      let calls = 0;
      const provider = new P({
        resolver: async () => {
          calls++;
          if (calls === 1) { await new Promise<void>((r) => { release = r; }); return cfg('alias/old'); }
          return cfg('alias/new');
        },
        fallback: new E(randomBytes(32).toString('hex')),
        invalidationBus: null,
      });
      const warming = provider.ensureWarmed('org-acme');
      await new Promise((r) => setImmediate(r));
      provider.evict('org-acme');
      release();
      await warming;
      expect(provider.kidFor('org-acme')).toBe('alias/new');
    });

    it('a cached key expires after its TTL (5 minutes by default) and the next touch re-resolves', async () => {
      const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E, PER_ORG_KMS_CACHE_TTL_MS } = await import('../src/utils/secret-encryption.js');
      expect(PER_ORG_KMS_CACHE_TTL_MS).toBe(5 * 60_000);
      mockSend.mockImplementation(async () => ({ Plaintext: randomBytes(32) }));
      let t = 1_000_000;
      let current = cfg('alias/old');
      const resolver = jest.fn(async () => current);
      const onEvict = jest.fn();
      const provider = new P({ resolver, fallback: new E(randomBytes(32).toString('hex')), invalidationBus: null, now: () => t, onEvict });
      await provider.ensureWarmed('org-acme');
      current = cfg('alias/new');

      t += PER_ORG_KMS_CACHE_TTL_MS - 1;
      await provider.ensureWarmed('org-acme');
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(provider.kidFor('org-acme')).toBe('alias/old');

      t += 2;
      await provider.ensureWarmed('org-acme');
      expect(resolver).toHaveBeenCalledTimes(2);
      expect(provider.kidFor('org-acme')).toBe('alias/new');
      // The service's own config cache is dropped on expiry too.
      expect(onEvict).toHaveBeenCalledWith('org-acme');
    });

    it('a "no per-org config" answer expires too, so a config added elsewhere is picked up', async () => {
      const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E, PER_ORG_KMS_CACHE_TTL_MS } = await import('../src/utils/secret-encryption.js');
      mockSend.mockImplementation(async () => ({ Plaintext: randomBytes(32) }));
      let t = 0;
      let current: ReturnType<typeof cfg> | null = null;
      const provider = new P({ resolver: async () => current, fallback: new E(randomBytes(32).toString('hex')), invalidationBus: null, now: () => t });
      await provider.ensureWarmed('org-acme');
      expect(provider.kidFor('org-acme')).toBeUndefined();
      current = cfg();
      t += PER_ORG_KMS_CACHE_TTL_MS + 1;
      await provider.ensureWarmed('org-acme');
      expect(provider.kidFor('org-acme')).toBe('alias/org-acme');
    });

    it('a failed TTL refresh keeps serving the cached key rather than failing every secret read', async () => {
      const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E, PER_ORG_KMS_CACHE_TTL_MS } = await import('../src/utils/secret-encryption.js');
      mockSend.mockImplementation(async () => ({ Plaintext: randomBytes(32) }));
      let t = 0;
      let down = false;
      const resolver = jest.fn(async () => { if (down) throw new Error('platform down'); return cfg(); });
      const provider = new P({ resolver, fallback: new E(randomBytes(32).toString('hex')), invalidationBus: null, now: () => t });
      const before = await provider.deriveKeyAsync('org-acme');
      down = true;
      t += PER_ORG_KMS_CACHE_TTL_MS + 1;
      expect((await provider.deriveKeyAsync('org-acme')).equals(before)).toBe(true);
      // ...but an explicit eviction is never papered over.
      provider.evict('org-acme');
      await expect(provider.ensureWarmed('org-acme')).rejects.toThrow('platform down');
    });
  });

  describe('cold (unresolved) orgs — data-loss guard', () => {
    /** A provider whose org HAS per-org config, but which nothing has warmed. */
    const coldProvider = async () => {
      const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E } = await import('../src/utils/secret-encryption.js');
      const master = randomBytes(32);
      mockSend.mockResolvedValue({ Plaintext: master });
      return new P({
        resolver: async () => ({ keyId: 'alias/org-acme', ciphertextBase64: Buffer.from('opaque').toString('base64') }),
        fallback: new E(randomBytes(32).toString('hex')),
      });
    };

    it('REGRESSION: sync deriveKey REFUSES an unresolved org instead of using the shared master', async () => {
      // It used to silently return the FALLBACK key here. Because `kidFor` also
      // returned undefined, no kid was stamped, the both-kids-present mismatch
      // guard could never fire, and once the org warmed the secret was
      // permanently undecryptable (opaque auth-tag error, no diagnostic).
      const provider = await coldProvider();
      expect(() => provider.deriveKey('org-acme')).toThrow(/has not resolved org org-acme/);
    });

    it('reports no kid for an unresolved org rather than borrowing the fallback\'s', async () => {
      const provider = await coldProvider();
      expect(provider.kidFor('org-acme')).toBeUndefined();
    });

    it('REGRESSION: a cold write is encrypted under the PER-ORG key and reads back after warm-up', async () => {
      // The async API resolves the org before deriving, so the first-ever write
      // for an org already uses that org's own key — the cold-write/warm-read
      // sequence that used to lose the secret.
      const { encryptSecret: enc, decryptSecret: dec } = await import('../src/utils/secret-encryption.js');
      const provider = await coldProvider();

      const blob = await enc('first-ever-write', 'org-acme', provider);
      expect(blob.kid).toBe('alias/org-acme'); // stamped, so a later rotation is detectable
      expect(await dec(blob, 'org-acme', provider)).toBe('first-ever-write');
    });

    it('serves an org PROVEN to have no per-org config from the fallback, synchronously', async () => {
      const { PerOrgKmsKeyProvider: P, EnvKeyProvider: E } = await import('../src/utils/secret-encryption.js');
      const fallback = new E(randomBytes(32).toString('hex'));
      const provider = new P({ resolver: async () => null, fallback });

      // Unresolved → refuses. Resolved-as-no-config → fallback is the right answer.
      expect(() => provider.deriveKey('org-x')).toThrow(/has not resolved/);
      await provider.ensureWarmed('org-x');
      expect(provider.deriveKey('org-x').equals(fallback.deriveKey('org-x'))).toBe(true);
    });
  });
});

describe('isEncryptedBlob', () => {
  it('returns true for an actual blob', async () => {
    expect(isEncryptedBlob(await encryptSecret('x', 'org'))).toBe(true);
  });

  it('returns false for plaintext / non-blob shapes', async () => {
    expect(isEncryptedBlob('clear-text')).toBe(false);
    expect(isEncryptedBlob({ alg: 'wrong', iv: 'a', ciphertext: 'b' })).toBe(false);
    expect(isEncryptedBlob({ alg: 'aes-256-gcm-v1' })).toBe(false);
    expect(isEncryptedBlob(null)).toBe(false);
    expect(isEncryptedBlob(undefined)).toBe(false);
  });
});
