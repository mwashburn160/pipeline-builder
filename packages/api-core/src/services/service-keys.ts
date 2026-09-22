// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-service signing keys for INTERNAL service-to-service tokens.
 *
 * Before this, every service held one shared `JWT_SECRET`, so any service could
 * mint a token naming any OTHER service — "billing said so" was unfalsifiable,
 * and a single compromised workload could speak for the whole fleet. Now each
 * service signs with its OWN ES256 (EC P-256) key and consumers verify against
 * the public halves. The `kid` is bound to the signer's NAME, so a token whose
 * `sub` says `service:billing` but was signed with compliance's key is a
 * forgery, not a valid token with a confusing subject.
 *
 * ## Why public keys are distributed by CONFIG, not by per-service JWKS endpoints
 *
 * The user chain fetches platform's JWKS over HTTP because there is exactly
 * one signer and it is the one service that must be up for anybody to sign in.
 * The service chain is the opposite shape, and three properties decided it:
 *
 *  1. **`verifyServicePrincipal` must stay synchronous.** The global rate
 *     limiter's `skip` and app-factory's `/warmup` guard verify a service token
 *     BEFORE `requireAuth` runs, in synchronous Express callbacks. An HTTP JWKS
 *     fetch would force those async — a change that reaches into every
 *     service's limiter wiring.
 *  2. **No availability coupling.** With per-service JWKS endpoints, verifying a
 *     token minted by `billing` needs `billing` to be reachable — so billing
 *     being down would stop platform from accepting billing's in-flight calls,
 *     turning one outage into several. A mounted file has no such edge.
 *  3. **No N×N address config.** 10 services would each need every peer's
 *     host/port (and compose, which has no mesh, would need them too).
 *
 * So the deploy generates one keypair per service, mounts each private key ONLY
 * into its own service, and mounts ONE public bundle (read-only) everywhere:
 *
 *   `SERVICE_SIGNING_KEY_FILE`  this service's EC P-256 private key (PKCS#8 PEM)
 *   `SERVICE_KEY_BUNDLE_FILE`   `{ "services": { "<name>": { "keys": [<jwk>…] } } }`
 *
 * Rotation is by `kid`, in the same shape as the user chain: add the new public
 * key to the bundle (the service now publishes two), roll the bundle out, swap
 * that service's private key, then drop the retired public key. The bundle is
 * re-read on an interval AND on an mtime change, so a rotation needs no restart.
 * `deploy/bin/service-signing-keys.sh` generates and rotates both halves.
 *
 * ## Ephemeral mode
 *
 * With no `SERVICE_SIGNING_KEY_FILE` configured, a keypair is generated
 * IN-PROCESS per requested service name and registered in the in-memory bundle.
 * That keeps single-process suites and local one-off scripts working with no key
 * material, and it can never widen trust: the only verifier that accepts such a
 * token is the process that minted it. It is logged once at warn level, and
 * counted, because in a real deployment it means this service's peers will
 * reject everything it sends.
 */

import crypto, { type KeyObject } from 'crypto';
import { readFileSync, statSync } from 'fs';
import jwt from 'jsonwebtoken';
import { compactJws, encodeJwsSigningInput, publicJwkFrom, publicKeyFromJwk, type PublicJwk } from '../utils/jwk.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { errorMessage } from '../utils/response.js';

const logger = createLogger('service-keys');

/** The ONLY algorithm an internal service token may be signed with. */
export const SERVICE_TOKEN_ALGORITHM = 'ES256';

/** Subject prefix naming the calling service on a service token (`service:<name>`). */
export const SERVICE_SUBJECT_PREFIX = 'service:';

/** How long a loaded bundle is served before it is re-read (rotation pickup). */
const BUNDLE_REFRESH_INTERVAL_MS = 300_000; // 5 minutes

/** One service's published verification keys, as they appear in the bundle file. */
export interface ServiceKeyEntry {
  keys: PublicJwk[];
}

/** The document `SERVICE_KEY_BUNDLE_FILE` holds: every service's public keys. */
export interface ServiceKeyBundle {
  services: Record<string, ServiceKeyEntry>;
}

/** A signing key this process holds, in the forms signing needs. */
interface LocalSigningKey {
  serviceName: string;
  kid: string;
  privateKey: KeyObject;
  publicJwk: PublicJwk;
}

/** The bundle could not be loaded or does not know the key a token names. */
export class ServiceKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceKeyError';
  }
}

/**
 * This process's service identity — the `<name>` in `service:<name>` and the
 * name its key is published under. `SERVICE_NAME` is already set per service in
 * every deploy target (compose, minikube, ec2, eks), and is the same value the
 * audit and metric labels use, so there is one source of truth for "who am I".
 */
export function serviceIdentity(): string {
  return process.env.SERVICE_NAME || 'api';
}

// ---------------------------------------------------------------------------
// Local signing key
// ---------------------------------------------------------------------------

let localKey: LocalSigningKey | undefined;
let ephemeralKeys: Map<string, LocalSigningKey> | undefined;
let ephemeralWarned = false;

function loadConfiguredSigningKey(file: string): LocalSigningKey {
  const serviceName = serviceIdentity();
  let privateKey: KeyObject;
  try {
    privateKey = crypto.createPrivateKey(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ServiceKeyError(`Could not read the service signing key at ${file}: ${errorMessage(error)}`);
  }
  // publicJwkFrom rejects anything but an EC P-256 key, so a service configured
  // with (say) an RSA key fails HERE rather than minting tokens nobody verifies.
  const publicJwk = publicJwkFrom(crypto.createPublicKey(privateKey));
  return { serviceName, kid: publicJwk.kid, privateKey, publicJwk };
}

/**
 * The in-process key for `serviceName` in ephemeral mode, generated on first
 * use and registered in the in-memory bundle so this process can verify its own
 * tokens. Keyed by NAME (not just one key) so a single-process suite can mint
 * tokens for several services, as the real fleet does across processes.
 */
function ephemeralSigningKey(serviceName: string): LocalSigningKey {
  ephemeralKeys ??= new Map();
  const existing = ephemeralKeys.get(serviceName);
  if (existing) return existing;

  if (!ephemeralWarned) {
    ephemeralWarned = true;
    emitCounter('service_signing_ephemeral_key_total', { service: serviceIdentity() });
    logger.warn('SERVICE_SIGNING_KEY_FILE is not set — minting internal service tokens with an EPHEMERAL key. Only this process will accept them; every peer will reject them. Set SERVICE_SIGNING_KEY_FILE + SERVICE_KEY_BUNDLE_FILE (deploy/bin/service-signing-keys.sh).');
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = publicJwkFrom(publicKey);
  const generated: LocalSigningKey = { serviceName, kid: publicJwk.kid, privateKey, publicJwk };
  ephemeralKeys.set(serviceName, generated);
  return generated;
}

/** Whether this process signs with a mounted key (`configured`) or an in-process one. */
export function serviceKeyMode(): 'configured' | 'ephemeral' {
  return process.env.SERVICE_SIGNING_KEY_FILE ? 'configured' : 'ephemeral';
}

/**
 * The key `serviceName` must be signed with.
 *
 * In `configured` mode there is exactly ONE key — this service's — so a request
 * to sign as some OTHER service is a bug and throws: such a token would be
 * unverifiable everywhere (its `kid` names this service, its `sub` another).
 * Failing at the mint makes that an immediate, obvious error instead of a
 * runtime 401.
 */
function signingKeyFor(serviceName: string): LocalSigningKey {
  const file = process.env.SERVICE_SIGNING_KEY_FILE;
  if (!file) return ephemeralSigningKey(serviceName);

  if (!localKey || localKey.serviceName !== serviceIdentity()) {
    localKey = loadConfiguredSigningKey(file);
  }
  if (serviceName !== localKey.serviceName) {
    throw new ServiceKeyError(
      `This process is '${localKey.serviceName}' and holds only its own signing key, so it cannot mint a token for '${serviceName}'. `
      + 'Name the calling service correctly, or give the caller its own key.',
    );
  }
  return localKey;
}

// ---------------------------------------------------------------------------
// Verification bundle
// ---------------------------------------------------------------------------

interface LoadedBundle {
  /** `kid` → the service that published it, plus the verification key. */
  byKid: Map<string, { serviceName: string; key: KeyObject }>;
  loadedAt: number;
  mtimeMs: number;
}

let bundle: LoadedBundle | undefined;

function parseBundle(raw: string, file: string): Map<string, { serviceName: string; key: KeyObject }> {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new ServiceKeyError(`${file} is not valid JSON: ${errorMessage(error)}`);
  }
  const services = (document as Partial<ServiceKeyBundle>)?.services;
  if (!services || typeof services !== 'object') {
    throw new ServiceKeyError(`${file} has no "services" object`);
  }
  const byKid = new Map<string, { serviceName: string; key: KeyObject }>();
  for (const [serviceName, entry] of Object.entries(services)) {
    for (const jwk of entry?.keys ?? []) {
      if (!jwk?.kid) continue;
      try {
        byKid.set(jwk.kid, { serviceName, key: publicKeyFromJwk(jwk) });
      } catch (error) {
        // One unusable entry must not discard the rest of the bundle — the same
        // rule the JWKS cache applies to platform's published set.
        logger.warn('Skipping unusable service key', { serviceName, kid: jwk.kid, error: errorMessage(error) });
      }
    }
  }
  if (byKid.size === 0) throw new ServiceKeyError(`${file} contained no usable service keys`);
  return byKid;
}

/**
 * The `kid` → service map, re-read when the refresh interval has passed or the
 * file's mtime changed (so a rotation is picked up without a restart).
 *
 * In ephemeral mode the "bundle" is whatever this process generated for itself.
 * Never throws for a missing file in that mode — it just holds those keys.
 */
function verificationKeys(): Map<string, { serviceName: string; key: KeyObject }> {
  const file = process.env.SERVICE_KEY_BUNDLE_FILE;
  if (!file) {
    const local = new Map<string, { serviceName: string; key: KeyObject }>();
    for (const key of ephemeralKeys?.values() ?? []) {
      local.set(key.kid, { serviceName: key.serviceName, key: crypto.createPublicKey(key.privateKey) });
    }
    return local;
  }

  const now = Date.now();
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    // Unreadable now: keep serving a bundle already in hand (public keys don't
    // expire, and refusing every internal call because a mount blipped would be
    // a self-inflicted outage). With nothing in hand, fail closed below.
    if (bundle) return bundle.byKid;
  }
  if (bundle && bundle.mtimeMs === mtimeMs && now - bundle.loadedAt < BUNDLE_REFRESH_INTERVAL_MS) {
    return bundle.byKid;
  }

  try {
    const byKid = parseBundle(readFileSync(file, 'utf8'), file);
    bundle = { byKid, loadedAt: now, mtimeMs };
    return byKid;
  } catch (error) {
    if (bundle) {
      logger.warn('Service key bundle reload failed; continuing on the loaded copy', { file, error: errorMessage(error) });
      return bundle.byKid;
    }
    throw error instanceof ServiceKeyError ? error : new ServiceKeyError(String(error));
  }
}

/**
 * Whether `kid` belongs to an internal SERVICE key. This is how a bearer token
 * is routed between the two ES256 chains: both user and service tokens are
 * ES256 with a `kid`, and `kid` is an RFC 7638 thumbprint, so ownership of the
 * id — not a claim inside the token — decides which key set may verify it.
 * Returns `false` (never throws) when no bundle can be read; the token then
 * takes the user chain and is rejected there.
 */
export function isServiceKid(kid: string): boolean {
  try {
    return verificationKeys().has(kid);
  } catch {
    return false;
  }
}

/** Every service name the bundle publishes a key for. Diagnostics and tests. */
export function knownServiceNames(): string[] {
  try {
    return [...new Set([...verificationKeys().values()].map((v) => v.serviceName))].sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

/**
 * Sign `claims` as this service's internal token: ES256, `kid` = the signer's
 * thumbprint, `sub` = `service:<serviceName>`. `iat`/`exp` and the optional
 * issuer/audience are stamped here so there is one place that decides what a
 * service token says.
 *
 * Hand-rolled (rather than `jwt.sign`) only so the header carries the `kid` in
 * the same shape platform's signer produces — `crypto.sign` is synchronous, so
 * unlike the KMS path this costs nothing.
 */
export function signServiceJwt(
  claims: Record<string, unknown>,
  options: { serviceName: string; expiresInSeconds: number; issuer?: string; audience?: string },
): string {
  const key = signingKeyFor(options.serviceName);
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...claims,
    sub: `${SERVICE_SUBJECT_PREFIX}${options.serviceName}`,
    iat: now,
    exp: now + options.expiresInSeconds,
    ...(options.issuer ? { iss: options.issuer } : {}),
    ...(options.audience ? { aud: options.audience } : {}),
  };
  const signingInput = encodeJwsSigningInput(key.kid, body);
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf-8'), {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return compactJws(signingInput, signature);
}

/**
 * Verify an internal service token, SYNCHRONOUSLY, and return its claims.
 *
 * The security property this function exists for: the `kid` selects the key
 * AND names the signer, and the token's `sub` must agree. So `billing` cannot
 * be impersonated by any other service — not even one that holds a valid key of
 * its own — a guarantee no shared secret can give.
 *
 * @throws {jwt.JsonWebTokenError} unknown `kid`, wrong algorithm, bad
 *         signature, expired, or a `sub` that disagrees with the signing key.
 * @throws {ServiceKeyError} no verification bundle could be read at all — the
 *         token's validity is UNKNOWN and the caller must not treat it as valid.
 */
export function verifyServiceJwt<T = Record<string, unknown>>(
  token: string,
  options: { kid: string; issuer?: string; audience?: string },
): T {
  const entry = verificationKeys().get(options.kid);
  // EVERY emission of this counter carries the same label KEYS. The Prometheus
  // counter is registered lazily with whatever keys its first emission used,
  // and an increment with a different set throws — which `emitCounter`
  // swallows. So when the first token a pod verified was bad (`{ result }`
  // alone), every later `ok` and `subject_mismatch` (`{ result, service }`) was
  // silently dropped for the life of the process: the metric that tells you
  // service-to-service auth is healthy went quiet exactly when it mattered.
  if (!entry) {
    emitCounter('service_token_verify_total', { result: 'unknown_kid', service: 'unknown' });
    throw new jwt.JsonWebTokenError(`No published service key for kid ${options.kid}`);
  }
  let claims: T & { sub?: unknown };
  try {
    claims = jwt.verify(token, entry.key, {
      algorithms: [SERVICE_TOKEN_ALGORITHM],
      ...(options.issuer ? { issuer: options.issuer } : {}),
      ...(options.audience ? { audience: options.audience } : {}),
    }) as T & { sub?: unknown };
  } catch (error) {
    emitCounter('service_token_verify_total', { result: 'invalid', service: entry.serviceName });
    throw error;
  }
  if (claims.sub !== `${SERVICE_SUBJECT_PREFIX}${entry.serviceName}`) {
    // A valid signature by the WRONG service: the key belongs to `entry.serviceName`
    // but the token speaks for someone else: a cross-service forgery.
    emitCounter('service_token_verify_total', { result: 'subject_mismatch', service: entry.serviceName });
    throw new jwt.JsonWebTokenError(`Service token subject ${String(claims.sub)} was signed by ${entry.serviceName}`);
  }
  emitCounter('service_token_verify_total', { result: 'ok', service: entry.serviceName });
  return claims;
}

/**
 * True while this service still publishes more than one verification key — i.e.
 * a signing-key rotation is open and the retiring key is still trusted. Feeds
 * the `secret_rotation_previous_set{secret="SERVICE_SIGNING_KEY"}` gauge.
 */
export function isRetiringServiceKeyPublished(): boolean {
  try {
    const me = serviceIdentity();
    return [...verificationKeys().values()].filter((v) => v.serviceName === me).length > 1;
  } catch {
    return false;
  }
}

/**
 * Test seam: drop the loaded signing key, the bundle and any ephemeral keys so
 * the next sign/verify re-reads the environment. Don't call from production code
 * — rotation is picked up by the refresh interval and the mtime check.
 */
export function _resetServiceKeysForTests(): void {
  localKey = undefined;
  bundle = undefined;
  ephemeralKeys = undefined;
  ephemeralWarned = false;
}
