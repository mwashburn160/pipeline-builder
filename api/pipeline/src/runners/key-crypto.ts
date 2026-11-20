// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The secret encryption the runner signing keys are stored under: api-core's
 * per-org envelope encryption (AES-256-GCM under an HKDF per-org key, or the
 * org's own KMS key when `SECRET_ENCRYPTION_PER_ORG_KMS=true`).
 *
 * {@link initRunnerKeyEncryption} runs once at startup: it warms the base
 * provider (`initSecretEncryption()`), and with per-org KMS on layers a
 * `PerOrgKmsKeyProvider` over it whose resolver asks platform
 * (`PLATFORM_INTERNAL.orgKmsConfig`) and caches each answer for 60 s. Until it
 * has succeeded, runners are unavailable (`encryption_not_configured`).
 *
 * The wrapped KMS master (`ciphertextBase64`) is never logged.
 */

import {
  callInternal,
  createLogger,
  decryptSecret,
  encryptSecret,
  EnvKeyProvider,
  errorMessage,
  getDefaultKeyProvider,
  getServiceAuthHeader,
  initSecretEncryption,
  InternalHttpClient,
  isEncryptedBlob,
  PerOrgKmsKeyProvider,
  PLATFORM_INTERNAL,
  serviceEndpoint,
  serviceIdentity,
  setKeyProvider,
  SYSTEM_ORG_ID,
  type KeyProvider,
  type PerOrgKmsConfig,
  type PerOrgKmsResolver,
} from '@pipeline-builder/api-core';

const logger = createLogger('runner-key-crypto');

/** How long one org's KMS config answer is reused. */
export const KMS_CONFIG_CACHE_MS = 60_000;

/** Encrypt / decrypt one signing key's PKCS#8 PEM, bound to the key's owning org. */
export interface KeySecrets {
  /** The stored form: `JSON.stringify(EncryptedBlob)`. */
  encrypt(pem: string, orgId: string): Promise<string>;
  decrypt(stored: string, orgId: string): Promise<string>;
}

/** The stored value parsed into a blob, or a throw (never a plaintext fallback). */
function parseStored(stored: string) {
  let blob: unknown;
  try { blob = JSON.parse(stored); } catch { throw new Error('stored key is not an encrypted blob'); }
  if (!isEncryptedBlob(blob)) throw new Error('stored key is not an encrypted blob');
  return blob;
}

/** Secrets over a given provider (the process default when omitted). */
export function keySecrets(provider?: () => KeyProvider): KeySecrets {
  return {
    encrypt: async (pem, orgId) => JSON.stringify(await encryptSecret(pem, orgId, provider ? provider() : getDefaultKeyProvider())),
    decrypt: (stored, orgId) => decryptSecret(parseStored(stored), orgId, provider ? provider() : getDefaultKeyProvider()),
  };
}

// -- The per-org KMS resolver (via platform) --------------------------------------

export type KmsConfigFetch = (orgId: string) => Promise<PerOrgKmsConfig | null>;

/** platform's `GET /internal/kms-config/:orgId`, as a system-org service call. Throws when it can't answer (fail closed). */
export const fetchOrgKmsConfig: KmsConfigFetch = async (orgId) => {
  const client = new InternalHttpClient(serviceEndpoint('platform'));
  const res = await callInternal(client, PLATFORM_INTERNAL.orgKmsConfig, {
    params: { orgId },
    options: { headers: { Authorization: getServiceAuthHeader({ serviceName: serviceIdentity(), orgId: SYSTEM_ORG_ID, role: 'member' }) } },
  });
  if (res.ok) return res.data.kmsConfig;
  // An unknown or deleted org has no per-org config.
  if (res.reason === 'status' && res.status === 404) return null;
  throw new Error(`KMS config lookup failed (${res.reason === 'status' ? `HTTP ${res.status}` : res.reason})`);
};

/** A resolver that reuses each org's answer for {@link KMS_CONFIG_CACHE_MS}; failures are not cached. */
export function cachedKmsResolver(fetch: KmsConfigFetch = fetchOrgKmsConfig, now: () => number = Date.now) {
  const cache = new Map<string, { value: PerOrgKmsConfig | null; at: number }>();
  const resolver: PerOrgKmsResolver = async (orgId) => {
    const k = orgId.toLowerCase();
    const hit = cache.get(k);
    if (hit && now() - hit.at < KMS_CONFIG_CACHE_MS) return hit.value;
    const value = await fetch(k);
    cache.set(k, { value, at: now() });
    return value;
  };
  return { resolver, evict: (orgId: string) => { cache.delete(orgId.toLowerCase()); } };
}

// -- Startup ----------------------------------------------------------------------

interface EncryptionState {
  ready: boolean;
  /** The provider for orgs without a per-org KMS key (re-encrypt decrypts with it after a per-org config is removed). */
  base: KeyProvider | null;
  perOrg: { provider: PerOrgKmsKeyProvider; evict: (orgId: string) => void } | null;
}

const state: EncryptionState = { ready: false, base: null, perOrg: null };

/** Whether secret encryption is set up, so keys can be stored and read. */
export function encryptionReady(): boolean { return state.ready; }

/** The base provider (shared master), or null before startup. */
export function baseKeyProvider(): KeyProvider | null { return state.base; }

/** Forget an org's cached KMS config and master (after its per-org KMS config changed). */
export function evictOrgKms(orgId: string): void {
  state.perOrg?.evict(orgId);
  state.perOrg?.provider.evict(orgId);
}

/**
 * Warm the base provider and, with per-org KMS on, install the per-org
 * provider. Never throws: a failure is logged (without key material) and leaves
 * runners unavailable.
 */
export async function initRunnerKeyEncryption(env: NodeJS.ProcessEnv = process.env, fetch: KmsConfigFetch = fetchOrgKmsConfig): Promise<boolean> {
  try {
    const { provider } = await initSecretEncryption();
    // No KMS master: the env master must be usable, or nothing can be stored.
    const base = provider ?? new EnvKeyProvider();
    state.base = base;
    if (env.SECRET_ENCRYPTION_PER_ORG_KMS === 'true') {
      const cached = cachedKmsResolver(fetch);
      const perOrg = new PerOrgKmsKeyProvider({ resolver: cached.resolver, fallback: base });
      setKeyProvider(perOrg);
      state.perOrg = { provider: perOrg, evict: cached.evict };
    }
    state.ready = true;
    logger.info('Runner signing-key encryption initialized', { kms: !!provider, perOrgKms: !!state.perOrg });
    return true;
  } catch (err) {
    state.ready = false;
    logger.error('Runner signing-key encryption is not configured; pipeline runners are unavailable', { error: errorMessage(err) });
    return false;
  }
}

/** Tests: set the readiness flag (and optionally the base provider) directly. */
export function setEncryptionStateForTesting(over: Partial<EncryptionState> | null): void {
  if (over === null) { state.ready = false; state.base = null; state.perOrg = null; return; }
  Object.assign(state, over);
}
