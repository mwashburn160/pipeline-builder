// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  Per-org envelope encryption for secret columns.
 *
 * Today's posture for org-scoped secrets (aiProviderKeys, webhook URLs,
 * registry credentials) is clear-text in Mongo / Postgres with app-layer
 * masking on output. This module is the encryption primitive that lets the
 * model layer swap clear-text strings for `EncryptedBlob` values at write
 * time and decrypt at read time.
 *
 * Cryptography * - AES-256-GCM (authenticated encryption).
 * - Per-org key derived via HKDF-SHA256(masterKey, salt=orgId, info='secrets-v1').
 * Each org gets a unique key without operator key-management ceremony.
 * - 12-byte IV generated per encryption with `crypto.randomBytes`.
 * - 16-byte authentication tag concatenated with ciphertext (standard GCM).
 *
 * Operator configuration * - `SECRET_ENCRYPTION_KEY` env: hex- or base64-encoded 32-byte master key.
 * Required when `encryptSecret`/`decryptSecret` are called. Missing key
 * throws  encryption is fail-closed; we never silently round-trip a
 * secret as plaintext.
 *
 * KMS migration path * - The two exported functions take a `provider` parameter. The default
 * `EnvKeyProvider` implements HKDF derivation. A future `AwsKmsProvider`
 * plugs in here: it can call KMS `Encrypt` / `Decrypt` to wrap a DEK
 * rather than holding a master key in env. The on-disk blob shape
 * (`{ alg, iv, ciphertext, kid? }`) is forward-compatible  `kid`
 * carries the KMS key id when the provider needs it.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

/** On-disk shape of an encrypted secret. JSON-serializable. */
export interface EncryptedBlob {
  /** Algorithm tag. Bump on format change so a future migration can detect old blobs. */
  alg: 'aes-256-gcm-v1';
  /** Base64-encoded 12-byte IV. */
  iv: string;
  /** Base64-encoded ciphertext + 16-byte authentication tag concatenated. */
  ciphertext: string;
  /** Optional key id  populated by KMS-backed providers, ignored by the env provider. */
  kid?: string;
}

/** Pluggable key source. Env-backed by default; KMS-backed available. */
export interface KeyProvider {
  /** Derive a 32-byte symmetric key bound to `orgId`. */
  deriveKey(orgId: string): Buffer;
  /** Optional async variant for providers that need to do I/O (e.g.
   *  per-org KMS lookup the first time an org is seen). Default
   *  implementation forwards to the sync `deriveKey`. */
  deriveKeyAsync?(orgId: string): Promise<Buffer>;
  /** Optional KMS-key-id this provider used for `orgId`. Embedded in the
   *  `EncryptedBlob.kid` field on write so decrypt can verify the right
   *  KMS CMK is being used (defense against an attacker who swaps a blob
   *  between orgs). Default returns undefined (env provider). */
  kidFor?(orgId: string): string | undefined;
}

/**
 * Default provider  derives a per-org key from `SECRET_ENCRYPTION_KEY` via
 * HKDF-SHA256. Suitable for self-hosted / dev where operators don't have KMS.
 *
 * Fails fast if the env is missing or the key is the wrong length so misconfig
 * surfaces at first use rather than silently fingerprinting all writes with
 * a default zero key.
 */
export class EnvKeyProvider implements KeyProvider {
  private readonly masterKey: Buffer;

  constructor(masterKeyOverride?: string) {
    const raw = masterKeyOverride ?? process.env.SECRET_ENCRYPTION_KEY;
    if (!raw) {
      throw new Error('SECRET_ENCRYPTION_KEY env is required for secret encryption');
    }
    // Accept either hex (64 chars) or base64 (44 chars including padding) for
    // operator convenience  both decode to a 32-byte key.
    const decoded = raw.length === 64 && /^[0-9a-f]+$/i.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
    if (decoded.length !== 32) {
      throw new Error(`SECRET_ENCRYPTION_KEY must decode to 32 bytes (got ${decoded.length})`);
    }
    this.masterKey = decoded;
  }

  deriveKey(orgId: string): Buffer {
    // HKDF binds the master key to the org so two orgs encrypting the same
    // plaintext produce different ciphertexts  keeps a stolen DB unable to
    // tell which orgs share secrets via ciphertext comparison.
    const derived = hkdfSync( 'sha256',
      this.masterKey,
      Buffer.from(orgId, 'utf8'),
      'secrets-v1',
      32,
    );
    // hkdfSync returns ArrayBuffer in older Node typings; normalize to Buffer.
    return Buffer.from(derived);
  }
}

/**
 *  AWS-KMS-backed KeyProvider.
 *
 * Trade-off picked: store ONE master key encrypted under a KMS CMK; on
 * first use, call `kms:Decrypt` to recover the master key bytes; HKDF-
 * derive per-org from it (same as EnvKeyProvider). The process then holds
 * the plaintext master key in memory until restart.
 *
 * PROS: one KMS call per process lifetime (cheap, low p99 impact),
 * the encrypted-master-key blob is safe to commit/log/checkin,
 * KMS audit log records when the master is recovered.
 * CONS: process memory still holds the master key  same posture as
 * EnvKeyProvider once warmed up. For stronger isolation an
 * operator can move to per-record envelope encryption (call
 * GenerateDataKey on every write); that's a follow-on.
 *
 * Operator setup * 1. Create a KMS CMK with key policy allowing the platform service's
 * IAM role kms:Decrypt.
 * 2. Generate a random 32-byte master * head -c 32 /dev/urandom | base64
 * 3. Wrap it with KMS * aws kms encrypt --key-id <KEY_ID> \
 * --plaintext <base64-from-step-2> --output text \
 * --query CiphertextBlob
 * 4. Set on the service * SECRET_ENCRYPTION_KMS_KEY_ID=<KEY_ID>
 * SECRET_ENCRYPTION_KMS_CIPHERTEXT=<base64-output-of-step-3>
 * 5. Pick this provider via `setKeyProvider(new KmsKeyProvider())`.
 *
 * Construct lazily  importing the AWS SDK has a non-trivial cold-start
 * cost so envs that stay on EnvKeyProvider never load it.
 */
export class KmsKeyProvider implements KeyProvider {
  private masterKeyCache: Buffer | null = null;
  private readonly keyId: string;
  private readonly ciphertextB64: string;
  private readonly region?: string;
  private readonly endpoint?: string;
  private decryptInFlight: Promise<Buffer> | null = null;

  constructor(opts?: { keyId?: string; ciphertextBase64?: string; region?: string; endpoint?: string }) {
    const keyId = opts?.keyId ?? process.env.SECRET_ENCRYPTION_KMS_KEY_ID;
    const ciphertext = opts?.ciphertextBase64 ?? process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT;
    if (!keyId) throw new Error('SECRET_ENCRYPTION_KMS_KEY_ID env is required for KmsKeyProvider');
    if (!ciphertext) throw new Error('SECRET_ENCRYPTION_KMS_CIPHERTEXT env is required for KmsKeyProvider');
    this.keyId = keyId;
    this.ciphertextB64 = ciphertext;
    this.region = opts?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    this.endpoint = opts?.endpoint ?? process.env.AWS_KMS_ENDPOINT;
  }

  deriveKey(orgId: string): Buffer {
    if (!this.masterKeyCache) {
      throw new Error( 'KmsKeyProvider is not warmed up. Call `await provider.warmup()` once at service startup before any encrypt/decrypt.',
      );
    }
    const derived = hkdfSync('sha256', this.masterKeyCache, Buffer.from(orgId, 'utf8'), 'secrets-v1', 32);
    return Buffer.from(derived);
  }

  /**
   * Eagerly recover the master key from KMS so subsequent `deriveKey`
   * calls are sync. Idempotent  concurrent callers share the same in-
   * flight promise so we don't spawn multiple KMS Decrypt requests at
   * boot. Throws on any KMS failure; the caller (typically the service's
   * onBeforeStart hook) decides whether to fall back to a different
   * provider or fail-startup.
   */
  async warmup(): Promise<void> {
    if (this.masterKeyCache) return;
    if (!this.decryptInFlight) {
      this.decryptInFlight = this.fetchAndDecrypt();
    }
    this.masterKeyCache = await this.decryptInFlight;
  }

  private async fetchAndDecrypt(): Promise<Buffer> {
    // Dynamic import so EnvKeyProvider-only envs don't load the SDK.
    const { KMSClient, DecryptCommand } = await import('@aws-sdk/client-kms');
    const client = new KMSClient({
      region: this.region,
      ...(this.endpoint ? { endpoint: this.endpoint }: {}),
    });
    const resp = await client.send(new DecryptCommand({
      KeyId: this.keyId,
      CiphertextBlob: Buffer.from(this.ciphertextB64, 'base64'),
    }));
    if (!resp.Plaintext) {
      throw new Error('KMS Decrypt returned an empty Plaintext');
    }
    const buf = Buffer.from(resp.Plaintext);
    if (buf.length !== 32) {
      throw new Error(`KMS Decrypt returned ${buf.length}-byte key; expected 32`);
    }
    return buf;
  }
}

// Lazy singleton  operator code in long-lived services pays the env-parse
// cost once, and tests can mint their own provider with a literal key.
let defaultProvider: KeyProvider | null = null;
function getDefaultProvider(): KeyProvider {
  if (!defaultProvider) defaultProvider = new EnvKeyProvider();
  return defaultProvider;
}

/** Read the active default provider. Exposed so service code (e.g. an
 *  admin endpoint that just rotated an org's KMS config) can call
 *  `provider.evict(orgId)` on the live provider rather than reconstructing
 *  one. Triggers lazy initialization on first access, same as the internal
 *  callers below. */
export function getDefaultKeyProvider(): KeyProvider {
  return getDefaultProvider();
}

/** Reset the cached default provider  for tests that mutate `process.env`. */
export function resetDefaultKeyProvider(): void { defaultProvider = null; }

/** Replace the default provider  services that opt into KMS call this
 * once at startup with a warmed-up `KmsKeyProvider`. */
export function setKeyProvider(provider: KeyProvider): void { defaultProvider = provider; }

/** Per-org KMS config the operator supplies. The `keyId` identifies the
 *  KMS CMK to call Decrypt on; `ciphertextBase64` is the wrapped 32-byte
 *  master generated by `aws kms encrypt` against that key. */
export interface PerOrgKmsConfig {
  keyId: string;
  ciphertextBase64: string;
}

/**
 * Async resolver that maps an org id to its KMS config. Returns `null` when
 * the org has no per-org config — the provider then falls back to the
 * `fallback` provider supplied at construction (usually an EnvKeyProvider
 * or a default KmsKeyProvider).
 */
export type PerOrgKmsResolver = (orgId: string) => Promise<PerOrgKmsConfig | null>;

/**
 * Per-org KMS-backed KeyProvider. The blast radius of a KMS key compromise
 * is one org instead of every org under a shared master.
 *
 * Each org has its own KMS CMK + its own wrapped master (stored in Mongo
 * via the operator's setup script). On first encrypt/decrypt for an org,
 * the provider:
 *   1. Calls the resolver to fetch the org's KMS config.
 *   2. Calls `kms:Decrypt` to recover the 32-byte master.
 *   3. Caches the recovered master in-memory for the process lifetime.
 *   4. HKDF-derives per-call from that master + the org id salt.
 *
 * Blobs encrypted by this provider carry `kid = <kms-key-id>` so the
 * decrypt path detects a stale config (operator rotated the key but
 * existing rows weren't re-encrypted) BEFORE AES-GCM throws an opaque
 * authentication-tag error.
 *
 * Orgs without per-org config fall through to the `fallback` provider —
 * mixed-mode deployments where some orgs have KMS isolation and others
 * stay on the shared master are explicitly supported.
 */
export class PerOrgKmsKeyProvider implements KeyProvider {
  /** Cached per-org master keys, keyed by orgId. */
  private readonly masters = new Map<string, { key: Buffer; kid: string }>();
  /** Resolved per-org configs cached for the process lifetime. */
  private readonly configs = new Map<string, PerOrgKmsConfig>();
  /** In-flight resolver promises so concurrent first-touch callers share one KMS Decrypt.
   *  Resolves to `null` for orgs with no per-org config — caller treats null as
   *  "fall through to the fallback provider", same as a cold cache miss. */
  private readonly inFlight = new Map<string, Promise<{ key: Buffer; kid: string } | null>>();
  /** Provider used for orgs that have no per-org config. */
  private readonly fallback: KeyProvider;
  private readonly resolver: PerOrgKmsResolver;
  private readonly region?: string;
  private readonly endpoint?: string;

  constructor(opts: {
    resolver: PerOrgKmsResolver;
    fallback: KeyProvider;
    region?: string;
    endpoint?: string;
  }) {
    this.resolver = opts.resolver;
    this.fallback = opts.fallback;
    this.region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    this.endpoint = opts.endpoint ?? process.env.AWS_KMS_ENDPOINT;
  }

  /** Sync `deriveKey` only works for already-warmed orgs. Cold orgs fall
   *  through to the fallback provider. Callers that want per-org isolation
   *  MUST `await deriveKeyAsync(orgId)` once first (e.g. during request setup
   *  or as part of a warmup pass) — otherwise the org silently uses the
   *  shared master. */
  deriveKey(orgId: string): Buffer {
    const cached = this.masters.get(orgId);
    if (!cached) return this.fallback.deriveKey(orgId);
    const derived = hkdfSync('sha256', cached.key, Buffer.from(orgId, 'utf8'), 'secrets-v1', 32);
    return Buffer.from(derived);
  }

  async deriveKeyAsync(orgId: string): Promise<Buffer> {
    await this.ensureWarmed(orgId);
    return this.deriveKey(orgId);
  }

  kidFor(orgId: string): string | undefined {
    return this.masters.get(orgId)?.kid ?? this.fallback.kidFor?.(orgId);
  }

  /**
   * Resolve the org's KMS config, call Decrypt, cache the master. Subsequent
   * calls for the same org are no-ops. Concurrent callers share the in-flight
   * Decrypt promise.
   *
   * Returns silently when the org has no per-org config — the fallback
   * provider handles those orgs.
   */
  async ensureWarmed(orgId: string): Promise<void> {
    if (this.masters.has(orgId)) return;
    // Install the in-flight promise SYNCHRONOUSLY before yielding so concurrent
    // callers find it on the second-and-later passes. Awaiting the resolver
    // before populating the map is the bug that lets a Promise.all of 3
    // callers fire 3 KMS Decrypts.
    let promise = this.inFlight.get(orgId);
    if (!promise) {
      promise = this.resolveAndDecrypt(orgId);
      this.inFlight.set(orgId, promise);
      void promise.finally(() => { if (this.inFlight.get(orgId) === promise) this.inFlight.delete(orgId); });
    }
    const result = await promise;
    if (result) this.masters.set(orgId, result);
  }

  private async resolveAndDecrypt(orgId: string): Promise<{ key: Buffer; kid: string } | null> {
    let cfg = this.configs.get(orgId);
    if (!cfg) {
      const resolved = await this.resolver(orgId);
      if (!resolved) return null; // no per-org config → caller uses fallback
      cfg = resolved;
      this.configs.set(orgId, cfg);
    }
    const key = await this.fetchAndDecrypt(cfg);
    return { key, kid: cfg.keyId };
  }

  private async fetchAndDecrypt(cfg: PerOrgKmsConfig): Promise<Buffer> {
    const { KMSClient, DecryptCommand } = await import('@aws-sdk/client-kms');
    const client = new KMSClient({
      region: this.region,
      ...(this.endpoint ? { endpoint: this.endpoint } : {}),
    });
    const resp = await client.send(new DecryptCommand({
      KeyId: cfg.keyId,
      CiphertextBlob: Buffer.from(cfg.ciphertextBase64, 'base64'),
    }));
    if (!resp.Plaintext) throw new Error(`KMS Decrypt returned empty Plaintext for key ${cfg.keyId}`);
    const buf = Buffer.from(resp.Plaintext);
    if (buf.length !== 32) throw new Error(`KMS Decrypt returned ${buf.length}-byte key for ${cfg.keyId}; expected 32`);
    return buf;
  }

  /** Evict a cached per-org master. Use after a key rotation so the next
   *  touch re-fetches the new wrapped master from the resolver. */
  evict(orgId: string): void {
    this.masters.delete(orgId);
    this.configs.delete(orgId);
  }
}

/**
 * Encrypt a plaintext string for storage. Returns an `EncryptedBlob` that
 * can be JSON-serialized into the underlying column / Mongo document.
 *
 * Empty strings round-trip as `null` so the calling model layer can treat
 * "no secret set" identically to "field absent".
 */
export function encryptSecret( plaintext: string,
  orgId: string,
  provider: KeyProvider = getDefaultProvider(),
): EncryptedBlob {
  if (!plaintext) {
    throw new Error('Refusing to encrypt empty string; caller should store null instead');
  }
  const key = provider.deriveKey(orgId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // PerOrgKmsKeyProvider tags blobs with the KMS key id used so the
  // decrypt path can refuse to operate if the operator later swaps in a
  // different per-org config (a misconfigured swap shouldn't silently
  // accept a stale blob it can't verify against the right CMK).
  const kid = provider.kidFor?.(orgId);
  return {
    alg: 'aes-256-gcm-v1',
    iv: iv.toString('base64'),
    // GCM tag MUST travel with the ciphertext or `decryptSecret` can't
    // verify integrity  concatenate so the on-disk shape is one field.
    ciphertext: Buffer.concat([enc, tag]).toString('base64'),
    ...(kid !== undefined ? { kid } : {}),
  };
}

/**
 * Decrypt an `EncryptedBlob` written by `encryptSecret`. Throws on * - unknown `alg` (forces an explicit migration when the format changes)
 * - wrong orgId (HKDF binding mismatch fails the auth tag)
 * - tampered ciphertext (GCM auth tag check fails)
 *
 * Callers handle the throw  masking the failure as `null` would hide
 * silent corruption / wrong-org reads.
 */
export function decryptSecret( blob: EncryptedBlob,
  orgId: string,
  provider: KeyProvider = getDefaultProvider(),
): string {
  if (blob.alg !== 'aes-256-gcm-v1') {
    throw new Error(`Unsupported encryption alg: ${blob.alg}`);
  }
  // If both the provider AND the blob report a kid, they must match.
  // Mismatch usually means an operator rotated/replaced an org's KMS
  // config and is now reading a blob encrypted under the OLD key —
  // failing loud here beats letting AES-GCM throw an opaque auth-tag error.
  const providerKid = provider.kidFor?.(orgId);
  if (providerKid !== undefined && blob.kid !== undefined && providerKid !== blob.kid) {
    throw new Error(`KMS key id mismatch: blob was encrypted under ${blob.kid}, current provider uses ${providerKid} for org ${orgId}`);
  }
  const key = provider.deriveKey(orgId);
  const iv = Buffer.from(blob.iv, 'base64');
  const all = Buffer.from(blob.ciphertext, 'base64');
  // Split off the 16-byte auth tag appended in encryptSecret. Any tampering
  //  to either the ciphertext OR the tag  causes the next `final()` to
  // throw with "Unsupported state or unable to authenticate data".
  const tag = all.subarray(all.length - 16);
  const enc = all.subarray(0, all.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

/**
 * Type guard  handy for model layers that hold a column whose value may be
 * either a clear-text string (legacy / unencrypted) OR an encrypted blob
 * (post-migration). Mixed states arise mid-migration; the model decides
 * what to do (decrypt on read, encrypt on next write).
 */
export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  return ( typeof value === 'object'
    && value !== null
    && (value as { alg?: unknown }).alg === 'aes-256-gcm-v1'
    && typeof (value as { iv?: unknown }).iv === 'string'
    && typeof (value as { ciphertext?: unknown }).ciphertext === 'string'
  );
}
