// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The deployment's SAML SP keys (services/saml-sp-keys.ts) and the self-signed
 * certificate minting behind them (helpers/x509-self-signed.ts):
 *   - a minted certificate is a real X.509 v3 that Node parses and verifies,
 *     binding exactly the given key;
 *   - keys are generated ONCE per deployment and persisted with the private half
 *     encrypted — never in clear;
 *   - a stored key is reused (no regeneration), and two replicas racing to
 *     generate converge on the winner's key;
 *   - the result is cached per process.
 */

import crypto, { randomBytes } from 'crypto';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const store = new Map<string, Record<string, unknown>>();
const mockCreate = jest.fn<(doc: Record<string, unknown>) => Promise<unknown>>();

jest.unstable_mockModule('../src/models/saml-sp-key.js', () => ({
  default: {
    findById: (id: string) => ({ lean: async () => store.get(id) ?? null }),
    create: (doc: Record<string, unknown>) => mockCreate(doc),
  },
}));

process.env.SECRET_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const { createSelfSignedCertificate } = await import('../src/helpers/x509-self-signed.js');
const { getSamlSpKeys, __resetSamlSpKeysCache } = await import('../src/services/saml-sp-keys.js');

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  __resetSamlSpKeysCache();
  mockCreate.mockImplementation(async (doc) => {
    if (store.has(doc._id as string)) throw Object.assign(new Error('dup'), { code: 11000 });
    store.set(doc._id as string, doc);
    return doc;
  });
});

describe('createSelfSignedCertificate', () => {
  it('mints a parseable, self-verifying X.509 certificate for the key', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const now = new Date('2026-09-19T00:00:00Z');
    const pem = createSelfSignedCertificate({ privateKey, publicKey, commonName: 'SP test', now, validDays: 30 });
    const cert = new crypto.X509Certificate(pem);
    expect(cert.subject).toBe('CN=SP test');
    expect(cert.issuer).toBe('CN=SP test');
    expect(cert.verify(publicKey)).toBe(true);
    expect(cert.publicKey.export({ type: 'spki', format: 'der' })).toEqual(publicKey.export({ type: 'spki', format: 'der' }));
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(now.getTime() + 29 * 86_400_000);
  });

  it('uses GeneralizedTime past 2049', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = createSelfSignedCertificate({ privateKey, publicKey, commonName: 'far', now: new Date('2049-06-01T00:00:00Z'), validDays: 3650 });
    expect(new Date(new crypto.X509Certificate(pem).validTo).getUTCFullYear()).toBe(2059);
  });

  it('refuses a non-RSA key', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(() => createSelfSignedCertificate({ privateKey, publicKey, commonName: 'x' })).toThrow(/RSA/);
  });
});

describe('getSamlSpKeys', () => {
  it('generates signing + encryption keys once and stores the private halves ENCRYPTED', async () => {
    const keys = await getSamlSpKeys();
    expect(mockCreate).toHaveBeenCalledTimes(3);
    for (const purpose of ['signing', 'encryption'] as const) {
      const doc = store.get(purpose)!;
      expect(doc.privateKeyEncrypted).not.toContain('PRIVATE KEY');
      expect(String(doc.privateKeyEncrypted).startsWith('{')).toBe(true);
      expect(doc.certificate).toBe(keys[purpose].certificate);
      // The certificate binds the private key we hand back.
      const cert = new crypto.X509Certificate(keys[purpose].certificate);
      expect(cert.checkPrivateKey(crypto.createPrivateKey(keys[purpose].privateKey))).toBe(true);
    }
    expect(keys.signing.certificate).not.toBe(keys.encryption.certificate);
    expect(keys.testMarkerKey).toHaveLength(32);
  });

  it('reuses stored keys (no regeneration) and caches per process', async () => {
    const first = await getSamlSpKeys();
    __resetSamlSpKeysCache();
    mockCreate.mockClear();
    const second = await getSamlSpKeys();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(second.signing).toEqual(first.signing);
    expect(second.testMarkerKey.equals(first.testMarkerKey)).toBe(true);
    expect(await getSamlSpKeys()).toBe(second);
  });

  it('converges on the winner when another replica generated first', async () => {
    // Simulate the race: our read sees nothing, then the other replica's insert lands.
    const winner = { privateKey: '', certificate: '' };
    mockCreate.mockImplementationOnce(async () => {
      const { wrapEncrypted } = await import('../src/utils/secret-blob.js');
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      winner.privateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      winner.certificate = createSelfSignedCertificate({ privateKey, publicKey, commonName: 'winner' });
      store.set('signing', { _id: 'signing', privateKeyEncrypted: await wrapEncrypted(winner.privateKey, 'saml-sp-keys'), certificate: winner.certificate });
      throw Object.assign(new Error('dup'), { code: 11000 });
    });
    const keys = await getSamlSpKeys();
    expect(keys.signing).toEqual(winner);
  });
});
