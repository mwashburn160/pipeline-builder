// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Envelope encryption for org-scoped secret columns (AI provider keys, IdP
 * client secrets, webhook URLs/secrets, registry credentials).
 *
 * Cryptography — the same for every provider below:
 * - AES-256-GCM (authenticated encryption).
 * - Per-org key via HKDF-SHA256(master, salt=orgId, info='secrets-v1'), so two
 *   orgs encrypting the same plaintext produce different ciphertexts and a
 *   stolen database cannot tell which orgs share a secret by comparison.
 * - 12-byte IV per encryption from `crypto.randomBytes`.
 * - 16-byte GCM auth tag concatenated onto the ciphertext.
 *
 * WHERE THE MASTER COMES FROM is the only axis that varies, and all three
 * providers are implemented — pick one per deployment:
 *
 * | provider               | master                              | blast radius       |
 * |------------------------|-------------------------------------|--------------------|
 * | `EnvKeyProvider`       | `SECRET_ENCRYPTION_KEY`, plaintext  | every org          |
 * | `KmsKeyProvider`       | KMS-wrapped, unwrapped once at boot | every org          |
 * | `PerOrgKmsKeyProvider` | one KMS-wrapped master PER ORG      | one org            |
 *
 * `initSecretEncryption()` selects between the first two from env and warms the
 * result; platform layers `PerOrgKmsKeyProvider` over it (orgs with no per-org
 * CMK fall through to the base provider), so a deployment can run mixed-mode.
 * Call it once at startup — before that, the lazy default is `EnvKeyProvider`,
 * which is correct for dev and self-hosted installs with no KMS.
 *
 * Fail-closed throughout: a missing or wrong-length master throws rather than
 * round-tripping a secret as plaintext, and an unresolved per-org config throws
 * rather than guessing the shared master.
 *
 * The on-disk shape (`{ alg, iv, ciphertext, kid? }`) is provider-independent;
 * `kid` carries the KMS key id for the providers that have one, which is what
 * lets `decryptSecret` refuse a blob written under a since-rotated CMK instead
 * of surfacing an opaque auth-tag failure.
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
 * Operator setup:
 *   1. Create a KMS CMK whose key policy allows the service role `kms:Decrypt`.
 *      On the AWS targets `bin/setup.sh` / `template.yaml` grant that to the
 *      platform and plugin task roles when these vars are set.
 *   2. Generate a 32-byte master:  head -c 32 /dev/urandom | base64
 *   3. Wrap it:  aws kms encrypt --key-id <KEY_ID> --plaintext <base64-from-2> \
 *                  --output text --query CiphertextBlob
 *   4. Set on the service:
 *        SECRET_ENCRYPTION_KMS_KEY_ID=<KEY_ID>        (alias/<name> or key UUID)
 *        SECRET_ENCRYPTION_KMS_CIPHERTEXT=<base64-from-3>
 *
 * NO MANUAL WIRING: `initSecretEncryption()` picks this provider whenever both
 * vars are set and warms it before the service accepts traffic. (It used to
 * require a hand-written `setKeyProvider(new KmsKeyProvider())` that no service
 * ever called, so the mode was documented but unreachable.)
 *
 * Migrating env -> KMS: set the two vars above to the NEW wrapped master and
 * leave the old plaintext master in `SECRET_ENCRYPTION_KEY_PREVIOUS`. Reads
 * fall back to it for kid-less blobs until `reencrypt-secrets` has rewritten
 * them; see docs/runbooks/secret-rotation.md.
 *
 * The AWS SDK is imported lazily, so installs that stay on `EnvKeyProvider`
 * never pay its cold-start cost.
 */
/**
 * KMS-decrypt a base64 ciphertext into a 32-byte key. Shared by both KMS key
 * providers (single-master + per-org). `@aws-sdk/client-kms` is
 * dynamically imported so EnvKeyProvider-only envs never load the SDK.
 */
async function kmsDecrypt32(keyId: string, ciphertextB64: string, region?: string, endpoint?: string): Promise<Buffer> {
  const { KMSClient, DecryptCommand } = await import('@aws-sdk/client-kms');
  const client = new KMSClient({ region, ...(endpoint ? { endpoint } : {}) });
  const resp = await client.send(new DecryptCommand({
    KeyId: keyId,
    CiphertextBlob: Buffer.from(ciphertextB64, 'base64'),
  }));
  if (!resp.Plaintext) throw new Error(`KMS Decrypt returned an empty Plaintext for key ${keyId}`);
  const buf = Buffer.from(resp.Plaintext);
  if (buf.length !== 32) throw new Error(`KMS Decrypt returned ${buf.length}-byte key for ${keyId}; expected 32`);
  return buf;
}

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
    try {
      this.masterKeyCache = await this.decryptInFlight;
    } catch (err) {
      // A transient KMS failure must not permanently poison the provider: clear
      // the rejected in-flight promise so a later warmup() retries instead of
      // re-awaiting the same rejection forever (matches PerOrgKmsKeyProvider).
      this.decryptInFlight = null;
      throw err;
    }
  }

  private fetchAndDecrypt(): Promise<Buffer> {
    return kmsDecrypt32(this.keyId, this.ciphertextB64, this.region, this.endpoint);
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

/**
 * Rotation fallback: an `EnvKeyProvider` over `SECRET_ENCRYPTION_KEY_PREVIOUS`,
 * or null when that env is unset. `undefined` = not yet resolved. While a
 * master-key rotation is in progress, `decryptSecret` retries a failed decrypt
 * under this key, so rows written under the old master stay readable until the
 * re-encryption tool (platform `scripts/reencrypt-secrets.js`) has rewritten
 * them under the new one. Encryption NEVER uses it.
 */
let previousProvider: KeyProvider | null | undefined;
function getPreviousProvider(): KeyProvider | null {
  if (previousProvider === undefined) {
    const raw = process.env.SECRET_ENCRYPTION_KEY_PREVIOUS;
    previousProvider = raw ? new EnvKeyProvider(raw) : null;
  }
  return previousProvider;
}

/**
 * Resolve (and WARM) the rotation fallback.
 *
 * Two rotation shapes, and the order matters:
 *  - KMS master rotation: `SECRET_ENCRYPTION_KMS_CIPHERTEXT_PREVIOUS` holds the
 *    outgoing master wrapped under `SECRET_ENCRYPTION_KMS_KEY_ID_PREVIOUS` (or
 *    the current CMK, when only the master changed and not the key).
 *  - Migration FROM the env master TO KMS: the primary is the new KMS-wrapped
 *    master and the outgoing PLAINTEXT master stays in
 *    `SECRET_ENCRYPTION_KEY_PREVIOUS`. That is why the env form is still read
 *    when no KMS previous is configured, rather than being mutually exclusive.
 *
 * Warmed here because `decryptSecret` takes the previous provider as a SYNC
 * default parameter — a cold `KmsKeyProvider` would throw out of `deriveKey`
 * on the retry path and mask the original decryption error.
 */
async function initPreviousProvider(): Promise<void> {
  const wrappedPrevious = process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT_PREVIOUS;
  const previousKeyId = process.env.SECRET_ENCRYPTION_KMS_KEY_ID_PREVIOUS ?? process.env.SECRET_ENCRYPTION_KMS_KEY_ID;
  if (wrappedPrevious && previousKeyId) {
    const provider = new KmsKeyProvider({ keyId: previousKeyId, ciphertextBase64: wrappedPrevious });
    await provider.warmup();
    previousProvider = provider;
    return;
  }
  const plaintextPrevious = process.env.SECRET_ENCRYPTION_KEY_PREVIOUS;
  previousProvider = plaintextPrevious ? new EnvKeyProvider(plaintextPrevious) : null;
}

/**
 * The base (non-per-org) provider this environment asks for: the KMS-wrapped
 * master when both of its vars are set, otherwise the plaintext env master.
 *
 * Constructs eagerly, so it throws when the env master is required and missing.
 * `initSecretEncryption()` is the boot entry point and deliberately does NOT
 * call this for the env case; use it only where an instance is needed right
 * away — e.g. the per-org fallback, which is already past that check.
 */
export function createBaseKeyProvider(): KeyProvider {
  const keyId = process.env.SECRET_ENCRYPTION_KMS_KEY_ID;
  const ciphertext = process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT;
  return keyId && ciphertext ? new KmsKeyProvider({ keyId, ciphertextBase64: ciphertext }) : new EnvKeyProvider();
}

/**
 * Select, WARM and install the base key provider. Call once at startup, before
 * the service serves traffic.
 *
 * Warming matters: `KmsKeyProvider.deriveKey` is synchronous and refuses to work
 * cold, so without this every secret read/write would throw until something
 * happened to call `warmup()`. Doing it at boot also turns a bad CMK, a bad
 * wrapped master or a missing `kms:Decrypt` grant into a startup failure rather
 * than a 500 on the first request that touches a secret.
 *
 * Returns the warmed provider so a caller can layer `PerOrgKmsKeyProvider` over
 * it without constructing (and re-warming) a second one.
 */
export async function initSecretEncryption(): Promise<{ provider: KeyProvider | null; mode: 'env' | 'kms' }> {
  const keyId = process.env.SECRET_ENCRYPTION_KMS_KEY_ID;
  const ciphertext = process.env.SECRET_ENCRYPTION_KMS_CIPHERTEXT;

  // NO KMS CONFIGURED: deliberately touch nothing and report `null`.
  //
  // `EnvKeyProvider` needs no warming, so there is nothing to gain here — and
  // constructing one eagerly would make `SECRET_ENCRYPTION_KEY` a hard BOOT
  // requirement for every service that calls this, including dev and test runs
  // that never encrypt a secret. The lazy default stays exactly as it was: the
  // first `encryptSecret`/`decryptSecret` builds it, and a missing master throws
  // there. Callers that need an instance (the per-org fallback) construct their
  // own `EnvKeyProvider` when this returns null.
  if (!keyId || !ciphertext) return { provider: null, mode: 'env' };

  const provider = new KmsKeyProvider({ keyId, ciphertextBase64: ciphertext });
  await provider.warmup();
  setKeyProvider(provider);
  await initPreviousProvider();
  return { provider, mode: 'kms' };
}

/** Reset the cached default (and previous) provider  for tests that mutate `process.env`. */
export function resetDefaultKeyProvider(): void { defaultProvider = null; previousProvider = undefined; }

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
  /** Orgs the resolver has PROVEN have no per-org config — the fallback provider
   *  is the correct answer for these, and `deriveKey` may serve them
   *  synchronously. Distinct from "not yet resolved", which must not guess. */
  private readonly resolvedNoPerOrgConfig = new Set<string>();
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

  /**
   * Sync derive. Only correct for an org whose config has already been
   * RESOLVED — either it has a per-org master (use it) or it provably has no
   * per-org config (the fallback is then the right answer).
   *
   * For an UNRESOLVED org this THROWS rather than guessing. Falling through to
   * the fallback would silently encrypt that org's secrets under the SHARED
   * master and — because `kidFor` also returns undefined, so the
   * both-kids-present mismatch guard could never fire — leave them permanently
   * undecryptable once the org warmed (`decipher.final()` throws an opaque
   * auth-tag error with no diagnostic). Failing loud here matches
   * `KmsKeyProvider.deriveKey`, which refuses to work cold.
   *
   * `encryptSecret`/`decryptSecret` are async and await `deriveKeyAsync`, so
   * they resolve the org first and never hit this path; it is the backstop for
   * a caller that reaches for the sync API directly.
   */
  deriveKey(orgId: string): Buffer {
    const cached = this.masters.get(orgId);
    if (!cached) {
      if (this.resolvedNoPerOrgConfig.has(orgId)) return this.fallback.deriveKey(orgId);
      throw new Error( `PerOrgKmsKeyProvider has not resolved org ${orgId}. `
        + 'Call `await provider.ensureWarmed(orgId)` (or use the async encryptSecret/decryptSecret) '
        + 'before deriving a key — guessing the shared master would write secrets that cannot be decrypted later.',
      );
    }
    const derived = hkdfSync('sha256', cached.key, Buffer.from(orgId, 'utf8'), 'secrets-v1', 32);
    return Buffer.from(derived);
  }

  async deriveKeyAsync(orgId: string): Promise<Buffer> {
    await this.ensureWarmed(orgId);
    return this.deriveKey(orgId);
  }

  kidFor(orgId: string): string | undefined {
    const cached = this.masters.get(orgId);
    if (cached) return cached.kid;
    // Only speak for an org whose config is resolved; an unresolved org has no
    // meaningful kid, and claiming one would defeat the mismatch guard.
    if (this.resolvedNoPerOrgConfig.has(orgId)) return this.fallback.kidFor?.(orgId);
    return undefined;
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
    // Remember the NEGATIVE outcome too, so the sync `deriveKey` can tell
    // "no per-org config, fallback is correct" from "not resolved yet".
    else this.resolvedNoPerOrgConfig.add(orgId);
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

  private fetchAndDecrypt(cfg: PerOrgKmsConfig): Promise<Buffer> {
    return kmsDecrypt32(cfg.keyId, cfg.ciphertextBase64, this.region, this.endpoint);
  }

  /** Evict a cached per-org master. Use after a key rotation so the next
   *  touch re-fetches the new wrapped master from the resolver. */
  evict(orgId: string): void {
    this.masters.delete(orgId);
    this.configs.delete(orgId);
    // Also forget a NEGATIVE resolution, or an org that gains a per-org config
    // after being resolved as "no config" would keep using the shared master.
    this.resolvedNoPerOrgConfig.delete(orgId);
  }
}

/**
 * Derive the key for `orgId`, giving the provider a chance to do I/O first.
 *
 * This is why `encryptSecret`/`decryptSecret` are async: `PerOrgKmsKeyProvider`
 * needs one KMS Decrypt the first time it sees an org, and deriving
 * synchronously before that resolves would silently fall back to the shared
 * master and produce secrets that cannot be decrypted afterwards.
 */
async function deriveKeyFor(provider: KeyProvider, orgId: string): Promise<Buffer> {
  return provider.deriveKeyAsync ? provider.deriveKeyAsync(orgId) : provider.deriveKey(orgId);
}

/**
 * Encrypt a plaintext string for storage. Returns an `EncryptedBlob` that
 * can be JSON-serialized into the underlying column / Mongo document.
 *
 * Empty strings round-trip as `null` so the calling model layer can treat
 * "no secret set" identically to "field absent".
 */
export async function encryptSecret( plaintext: string,
  orgId: string,
  provider: KeyProvider = getDefaultProvider(),
): Promise<EncryptedBlob> {
  if (!plaintext) {
    throw new Error('Refusing to encrypt empty string; caller should store null instead');
  }
  // Resolve (and warm) the org BEFORE reading `kidFor` below, so a per-org KMS
  // blob is always stamped with the key it was actually encrypted under.
  const key = await deriveKeyFor(provider, orgId);
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
 *
 * `previous` (default: `SECRET_ENCRYPTION_KEY_PREVIOUS`, when set) is tried
 * only after the primary key fails, and only for kid-less blobs.
 */
export async function decryptSecret( blob: EncryptedBlob,
  orgId: string,
  provider: KeyProvider = getDefaultProvider(),
  previous: KeyProvider | null = getPreviousProvider(),
): Promise<string> {
  if (blob.alg !== 'aes-256-gcm-v1') {
    throw new Error(`Unsupported encryption alg: ${blob.alg}`);
  }
  // Warm first: `kidFor` and `deriveKey` below must both speak for the org's
  // real config, or the mismatch guard silently no-ops.
  const key = await deriveKeyFor(provider, orgId);
  // If both the provider AND the blob report a kid, they must match.
  // Mismatch usually means an operator rotated/replaced an org's KMS
  // config and is now reading a blob encrypted under the OLD key —
  // failing loud here beats letting AES-GCM throw an opaque auth-tag error.
  const providerKid = provider.kidFor?.(orgId);
  if (providerKid !== undefined && blob.kid !== undefined && providerKid !== blob.kid) {
    throw new Error(`KMS key id mismatch: blob was encrypted under ${blob.kid}, current provider uses ${providerKid} for org ${orgId}`);
  }
  try {
    return decryptWithKey(blob, key);
  } catch (err) {
    // Master-key rotation window: retry under SECRET_ENCRYPTION_KEY_PREVIOUS.
    // Only for a kid-less blob (the env-keyed shape) — a per-org KMS blob is
    // bound to its CMK and the shared previous master can never open it. The
    // ORIGINAL error surfaces when the previous key fails too, so a tampered or
    // wrong-org blob still fails loud exactly as before.
    if (previous && blob.kid === undefined) {
      try {
        return decryptWithKey(blob, await deriveKeyFor(previous, orgId));
      } catch { /* fall through to the primary error */ }
    }
    throw err;
  }
}

/** AES-256-GCM open of a blob under one derived key. Throws on any auth-tag failure. */
function decryptWithKey(blob: EncryptedBlob, key: Buffer): string {
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
 * Shape guard for a parsed `EncryptedBlob`. Callers hold a value that was JSON-
 * decoded from a secret column and must not hand anything else to
 * `decryptSecret`; this narrows it (or the caller rejects the value). Clear text
 * is NOT a supported stored form — the only consumer throws on a non-blob.
 */
export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  return ( typeof value === 'object'
    && value !== null
    && (value as { alg?: unknown }).alg === 'aes-256-gcm-v1'
    && typeof (value as { iv?: unknown }).iv === 'string'
    && typeof (value as { ciphertext?: unknown }).ciphertext === 'string'
  );
}
