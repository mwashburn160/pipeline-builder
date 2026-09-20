// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SAML service-provider key material for this deployment.
 *
 * KEY-MANAGEMENT DECISION: the keys are AUTO-GENERATED on first use and
 * PERSISTED per deployment (models/saml-sp-key.ts), not supplied through deploy
 * configuration. Reasons:
 *
 *   - every deploy target (compose, minikube, EC2, EKS) gets working signed
 *     AuthnRequests, SLO and encrypted assertions with no new secret to mount,
 *     rotate or forget;
 *   - the keys are shared by every replica through Mongo — a per-pod key would
 *     make the SP metadata differ by which pod served it;
 *   - the private halves never exist in clear at rest: they are EncryptedBlobs
 *     under SECRET_ENCRYPTION_KEY, the same envelope the IdP client secrets use.
 *
 * Two separate RSA-2048 keys, because SAML distinguishes them (`use="signing"`
 * vs `use="encryption"` in the metadata) and an IdP may pin each independently:
 * the signing key signs AuthnRequests (per-org opt-in) and every
 * LogoutRequest/LogoutResponse; the encryption key is what IdPs encrypt
 * assertions to. A third, symmetric key signs the dry-run marker on test
 * connections (see controllers/sso-test.ts).
 *
 * ROTATION: delete the document(s) from `saml_sp_keys` and restart the platform
 * replicas; a fresh key is minted on first use, and every org that relies on
 * signing/encryption must re-import the SP metadata at its IdP. Keys are cached
 * per process after first load for exactly that reason — a rotation is a
 * deliberate, restart-bounded event, not something that happens underneath a
 * live sign-in. See docs/authentication.md → "Service-provider keys".
 */

import crypto from 'crypto';
import { createLogger } from '@pipeline-builder/api-core';
import { createSelfSignedCertificate } from '../helpers/x509-self-signed.js';
import SamlSpKey, { type SamlSpKeyPurpose } from '../models/saml-sp-key.js';
import { unwrapEncrypted, wrapEncrypted } from '../utils/secret-blob.js';

const logger = createLogger('saml-sp-keys');

/** Encryption context for the private halves (a deployment key, not an org's). */
const SECRET_CONTEXT = 'saml-sp-keys';

/** An RSA private key (PKCS#8 PEM) and its self-signed certificate (PEM). */
export interface SpKeyPair {
  privateKey: string;
  certificate: string;
}

export interface SamlSpKeys {
  signing: SpKeyPair;
  encryption: SpKeyPair;
  /** HMAC key for the dry-run marker. */
  testMarkerKey: Buffer;
}

const CERT_COMMON_NAME: Record<'signing' | 'encryption', string> = {
  signing: 'Pipeline Builder SAML SP signing',
  encryption: 'Pipeline Builder SAML SP encryption',
};

/** Mongo duplicate-key: another replica generated the same purpose first. */
function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

async function readPair(purpose: 'signing' | 'encryption'): Promise<SpKeyPair | null> {
  const doc = await SamlSpKey.findById(purpose).lean();
  if (!doc?.certificate) return null;
  return {
    privateKey: await unwrapEncrypted(doc.privateKeyEncrypted, SECRET_CONTEXT, `saml-sp.${purpose}`),
    certificate: doc.certificate,
  };
}

async function loadOrCreatePair(purpose: 'signing' | 'encryption'): Promise<SpKeyPair> {
  const existing = await readPair(purpose);
  if (existing) return existing;

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const certificate = createSelfSignedCertificate({ privateKey, publicKey, commonName: CERT_COMMON_NAME[purpose] });
  try {
    await SamlSpKey.create({ _id: purpose, privateKeyEncrypted: await wrapEncrypted(pem, SECRET_CONTEXT), certificate });
    logger.info('Generated SAML service-provider key', { purpose });
    return { privateKey: pem, certificate };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const winner = await readPair(purpose);
    if (!winner) throw err;
    return winner;
  }
}

async function loadOrCreateSecret(purpose: Extract<SamlSpKeyPurpose, 'test-marker'>): Promise<Buffer> {
  const read = async (): Promise<Buffer | null> => {
    const doc = await SamlSpKey.findById(purpose).lean();
    return doc ? Buffer.from(await unwrapEncrypted(doc.privateKeyEncrypted, SECRET_CONTEXT, `saml-sp.${purpose}`), 'hex') : null;
  };
  const existing = await read();
  if (existing) return existing;
  const secret = crypto.randomBytes(32);
  try {
    await SamlSpKey.create({ _id: purpose, privateKeyEncrypted: await wrapEncrypted(secret.toString('hex'), SECRET_CONTEXT) });
    return secret;
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const winner = await read();
    if (!winner) throw err;
    return winner;
  }
}

let cached: Promise<SamlSpKeys> | null = null;

/**
 * This deployment's SP keys, generating any that don't exist yet. Cached per
 * process; a failed load is not cached, so the next call retries.
 */
export function getSamlSpKeys(): Promise<SamlSpKeys> {
  if (!cached) {
    cached = (async () => ({
      signing: await loadOrCreatePair('signing'),
      encryption: await loadOrCreatePair('encryption'),
      testMarkerKey: await loadOrCreateSecret('test-marker'),
    }))();
    cached.catch(() => { cached = null; });
  }
  return cached;
}

/** TEST-ONLY: forget the per-process cache. */
export function __resetSamlSpKeysCache(): void {
  cached = null;
}
