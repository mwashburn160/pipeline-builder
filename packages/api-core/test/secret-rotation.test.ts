// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end rotation drills for the secrets api-core owns
 * (docs/runbooks/secret-rotation.md): each proves the overlap window (old AND
 * new accepted while `*_PREVIOUS` is set) and then that the old value is
 * REJECTED once `*_PREVIOUS` is cleared — plus the probe registry that backs
 * the `secret_rotation_previous_set` gauge.
 */

import { randomBytes } from 'crypto';
import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';

import { verifyServiceJwt, _resetServiceKeysForTests } from '../src/services/service-keys.js';
import { installTestServiceKeys } from '../src/testing/service-tokens.js';
import { decodeJwtHeader } from '../src/utils/jwk.js';
import { decryptSecret, encryptSecret, resetDefaultKeyProvider } from '../src/utils/secret-encryption.js';
import { previousSecretStates, registerPreviousSecretProbe, SECRET_ROTATION_PREVIOUS_GAUGE } from '../src/utils/secret-rotation.js';

const ENV = ['SECRET_ENCRYPTION_KEY', 'SECRET_ENCRYPTION_KEY_PREVIOUS'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetDefaultKeyProvider();
});

describe('SERVICE_SIGNING_KEY rotation drill', () => {
  /**
   * The per-service signing key (#14) rotates by `kid`, not by a `*_PREVIOUS`
   * env value: the shared bundle publishes the retiring public key alongside
   * the incoming one, so tokens minted either side of the cutover verify, and
   * the rotation finishes by dropping the retiring key from the bundle.
   */
  it('old token: accepted before, accepted during overlap, rejected once the retiring key is dropped', () => {
    // Two generated identities standing in for the same service's old and new
    // key: `billing` holds the retiring key, `billing-next` the incoming one.
    const keys = installTestServiceKeys(['billing', 'billing-next']);
    try {
      const verify = (token: string) => verifyServiceJwt<{ sub: string }>(token, { kid: decodeJwtHeader(token)!.kid! });

      // Phase 0 — before rotation: only the current key is published.
      keys.publish(['billing']);
      const oldToken = keys.sign('billing');
      expect(verify(oldToken).sub).toBe('service:billing');

      // Phase 1 — overlap: both keys published, so both mints verify.
      keys.publish(['billing', 'billing-next']);
      const newToken = keys.sign('billing-next');
      expect(verify(oldToken).sub).toBe('service:billing');
      expect(verify(newToken).sub).toBe('service:billing-next');

      // Phase 2 — finished: the retiring key is dropped from the bundle.
      keys.publish(['billing-next']);
      expect(() => verify(oldToken)).toThrow(/No published service key/);
      expect(verify(newToken).sub).toBe('service:billing-next');
    } finally {
      keys.uninstall();
    }
  });
});

describe('SECRET_ENCRYPTION_KEY rotation drill', () => {
  const OLD = randomBytes(32).toString('hex');
  const NEW = randomBytes(32).toString('hex');

  beforeEach(() => {
    delete process.env.SECRET_ENCRYPTION_KEY_PREVIOUS;
    resetDefaultKeyProvider();
  });

  it('old blob: readable during overlap, re-encrypted under new, old blob rejected after PREVIOUS is cleared', async () => {
    process.env.SECRET_ENCRYPTION_KEY = OLD;
    resetDefaultKeyProvider();
    const oldBlob = await encryptSecret('sk-live-123', 'org-a');

    // Overlap — new primary, old previous.
    process.env.SECRET_ENCRYPTION_KEY = NEW;
    process.env.SECRET_ENCRYPTION_KEY_PREVIOUS = OLD;
    resetDefaultKeyProvider();
    expect(await decryptSecret(oldBlob, 'org-a')).toBe('sk-live-123');
    // Re-encryption (what platform's reencrypt tool does per row) writes under NEW only.
    const newBlob = await encryptSecret(await decryptSecret(oldBlob, 'org-a'), 'org-a');

    // Finished — previous cleared.
    delete process.env.SECRET_ENCRYPTION_KEY_PREVIOUS;
    resetDefaultKeyProvider();
    expect(await decryptSecret(newBlob, 'org-a')).toBe('sk-live-123');
    await expect(decryptSecret(oldBlob, 'org-a')).rejects.toThrow();
  });

  it('the previous key never rescues a wrong-org or tampered blob', async () => {
    process.env.SECRET_ENCRYPTION_KEY = OLD;
    resetDefaultKeyProvider();
    const blob = await encryptSecret('secret', 'org-a');
    process.env.SECRET_ENCRYPTION_KEY = NEW;
    process.env.SECRET_ENCRYPTION_KEY_PREVIOUS = OLD;
    resetDefaultKeyProvider();
    await expect(decryptSecret(blob, 'org-b')).rejects.toThrow();
    const raw = Buffer.from(blob.ciphertext, 'base64');
    raw[0] = (raw[0] + 1) % 256; // flip a ciphertext byte (no-bitwise: no XOR)
    await expect(decryptSecret({ ...blob, ciphertext: raw.toString('base64') }, 'org-a')).rejects.toThrow();
  });

  it('does not apply the shared previous key to a KMS-bound (kid) blob', async () => {
    process.env.SECRET_ENCRYPTION_KEY = OLD;
    resetDefaultKeyProvider();
    const blob = { ...(await encryptSecret('secret', 'org-a')), kid: 'arn:kms:some-key' };
    process.env.SECRET_ENCRYPTION_KEY = NEW;
    process.env.SECRET_ENCRYPTION_KEY_PREVIOUS = OLD;
    resetDefaultKeyProvider();
    await expect(decryptSecret(blob, 'org-a')).rejects.toThrow();
  });

  it('never ENCRYPTS under the previous key', async () => {
    process.env.SECRET_ENCRYPTION_KEY = NEW;
    process.env.SECRET_ENCRYPTION_KEY_PREVIOUS = OLD;
    resetDefaultKeyProvider();
    const blob = await encryptSecret('x', 'org-a');
    delete process.env.SECRET_ENCRYPTION_KEY_PREVIOUS;
    resetDefaultKeyProvider();
    expect(await decryptSecret(blob, 'org-a')).toBe('x');
  });
});

describe('previous-secret probes', () => {
  it('reports SERVICE_SIGNING_KEY by default, tracking a still-published retiring key', () => {
    expect(SECRET_ROTATION_PREVIOUS_GAUGE).toBe('secret_rotation_previous_set');
    const keyState = () => previousSecretStates().find((s) => s.secret === 'SERVICE_SIGNING_KEY');
    _resetServiceKeysForTests();
    // No bundle configured at all: nothing is retiring.
    expect(keyState()).toEqual({ secret: 'SERVICE_SIGNING_KEY', previousSet: false });

    // `billing-next` stands in for billing's INCOMING key: published under the
    // name `billing`, it is the rotation-overlap shape (two trusted keys).
    const keys = installTestServiceKeys(['billing', 'billing-next']);
    try {
      keys.becomeService('billing');
      keys.publish(['billing']);
      expect(keyState()?.previousSet).toBe(false);

      keys.publishKeys({ billing: [keys.keys.get('billing')!, keys.keys.get('billing-next')!] });
      expect(keyState()?.previousSet).toBe(true);
    } finally {
      keys.uninstall();
    }
  });

  it('includes registered probes and reports a throwing probe as false', () => {
    registerPreviousSecretProbe('TEST_OK', () => true);
    registerPreviousSecretProbe('TEST_BROKEN', () => { throw new Error('boom'); });
    const states = previousSecretStates();
    expect(states).toContainEqual({ secret: 'TEST_OK', previousSet: true });
    expect(states).toContainEqual({ secret: 'TEST_BROKEN', previousSet: false });
  });
});
