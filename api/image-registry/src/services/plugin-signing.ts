// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin image signing — the one place the plugin-signing key is used.
 *
 * The plugin build worker pushes an image, generates its SPDX SBOM, and asks
 * this service to sign the pushed digest and attach the SBOM as a signed
 * in-toto attestation. The key never leaves this pod: the plugin pod shares its
 * network namespace with untrusted tenant builds, so any credential reachable
 * from there is reachable from a Dockerfile `RUN` step (see api/plugin
 * supply-chain.ts). Verification needs only the PUBLIC key, which the plugin
 * service holds.
 *
 * cosign runs key-based with the transparency log OFF (`--tlog-upload=false`):
 * the public Rekor log would publish every org id and plugin name. Signatures
 * land beside the image as cosign's `sha256-<digest>.sig` / `.att` tags.
 */

import { execFile } from 'child_process';
import { createPublicKey, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import { createLogger, extractPredicate, SPDX_PREDICATE_TYPE } from '@pipeline-builder/api-core';

import { isPluginRepository, isPublicRepository, isSha256Digest } from './namespaces.js';
import {
  deleteManifest,
  headManifest,
  mintRepositoryPullToken,
  mintRepositoryPushToken,
} from './registry-client.js';
import { config } from '../config/index.js';

const logger = createLogger('plugin-signing');

const MAX_STDERR_BYTES = 1024 * 1024;
/** `verify-attestation` prints the whole signed SBOM (base64, in a DSSE envelope). */
const MAX_STDOUT_BYTES = 96 * 1024 * 1024;

/** SPDX predicate type cosign records for `--type spdxjson`. */

/**
 * cosign v3 changed three signing defaults; all three have to be pinned back or
 * signatures stop landing where this platform reads them:
 *
 * - `--new-bundle-format=false` — v3 defaults to attaching a Sigstore bundle
 *   through the OCI referrers API. The in-cluster registry:3 has no reliable
 *   referrers endpoint, and `dropSignature()` / the plugin service both address
 *   signatures by the legacy `sha256-<digest>.sig` / `.att` TAG.
 * - `--use-signing-config=false` — v3 fetches a TUF-provided signing config by
 *   default, which both reaches out to public Sigstore and makes
 *   `--tlog-upload=false` a hard error ("not supported with --use-signing-config").
 * - `--tlog-upload=false` — unchanged from v2: the public Rekor log would
 *   publish every org id and plugin name.
 *
 * All three are marked deprecated upstream ("this will be the only supported
 * format in future versions"), so a cosign bump must re-check them: the day they
 * are removed, signing has to move to a `--signing-config` file with no
 * transparency-log service instead.
 */
const COSIGN_SIGN_FLAGS = ['--new-bundle-format=false', '--use-signing-config=false', '--tlog-upload=false'];

/**
 * Verification side of {@link COSIGN_SIGN_FLAGS}: read the legacy tag layout,
 * and don't demand a Rekor entry for a signature that was never logged.
 */
const COSIGN_VERIFY_FLAGS = ['--new-bundle-format=false', '--insecure-ignore-tlog=true'];

export class PluginSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginSigningError';
  }
}

/**
 * cosign RAN and said no (non-zero exit): no signature / attestation verifies.
 * Distinct from an infrastructure failure (binary missing, timeout, key
 * unreadable), which stays a plain {@link PluginSigningError}.
 */
export class CosignRejectedError extends PluginSigningError {
  constructor(message: string) {
    super(message);
    this.name = 'CosignRejectedError';
  }
}

// -----------------------------------------------------------------------------
// Keys
// -----------------------------------------------------------------------------

interface SigningKey {
  /** cosign `--key` value. */
  key: string;
  /** Extra env (the import password for a local key). */
  env: Record<string, string>;
}

let localKeyImport: Promise<SigningKey> | null = null;

/** The KMS key, by alias only — an ARN embeds the AWS account id. */
function kmsKeyRef(): string {
  const id = config.pluginSigning.kmsKeyId;
  if (!id) throw new PluginSigningError('PLUGIN_SIGNING_MODE=kms requires PLUGIN_SIGNING_KMS_KEY_ID (alias/<name>)');
  if (!id.startsWith('alias/')) {
    throw new PluginSigningError('PLUGIN_SIGNING_KMS_KEY_ID must be a KMS alias (alias/<name>); a key ARN embeds the AWS account id');
  }
  return `awskms:///${id}`;
}

/**
 * cosign signs only with its own encrypted key format, while the deploy
 * generates a plain PKCS PEM (openssl, like every other key in deploy/). So
 * import the PEM once per process into a private temp dir under a random
 * password that never leaves this process.
 */
function importLocalKey(): Promise<SigningKey> {
  if (!localKeyImport) {
    localKeyImport = (async () => {
      const keyFile = config.pluginSigning.keyFile;
      if (!fs.existsSync(keyFile)) {
        throw new PluginSigningError(`Plugin signing key not found at ${keyFile} (run deploy/bin/plugin-signing-keys.sh)`);
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-cosign-'));
      const password = randomBytes(32).toString('hex');
      const prefix = path.join(dir, 'plugin-signing');
      await cosign(['import-key-pair', '--key', keyFile, '--output-key-prefix', prefix], { COSIGN_PASSWORD: password });
      return { key: `${prefix}.key`, env: { COSIGN_PASSWORD: password } };
    })();
    // A failed import must be retryable (the key Secret may mount late).
    localKeyImport.catch(() => { localKeyImport = null; });
  }
  return localKeyImport;
}

function signingKey(): Promise<SigningKey> {
  if (config.pluginSigning.mode === 'kms') return Promise.resolve({ key: kmsKeyRef(), env: {} });
  return importLocalKey();
}

let localPublicKeyFile: string | null = null;

/**
 * The key cosign VERIFIES with. KMS: the same alias (cosign fetches the public
 * half). Local: the public half DERIVED from the signing PEM — no second file
 * to keep in sync, and nothing to drift after a rotation.
 */
function verificationKeyRef(): string {
  if (config.pluginSigning.mode === 'kms') return kmsKeyRef();
  if (!localPublicKeyFile) {
    const keyFile = config.pluginSigning.keyFile;
    if (!fs.existsSync(keyFile)) {
      throw new PluginSigningError(`Plugin signing key not found at ${keyFile} (run deploy/bin/plugin-signing-keys.sh)`);
    }
    let pub: string;
    try {
      pub = createPublicKey(fs.readFileSync(keyFile, 'utf-8')).export({ format: 'pem', type: 'spki' }).toString();
    } catch (err) {
      throw new PluginSigningError(`Plugin signing key at ${keyFile} is not a readable private key: ${(err as Error).message}`);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-cosign-pub-'));
    const file = path.join(dir, 'plugin-signing.pub');
    fs.writeFileSync(file, pub);
    localPublicKeyFile = file;
  }
  return localPublicKeyFile;
}

/** @internal Reset the imported-key memo (tests only). */
export function _resetPluginSigningState(): void {
  localKeyImport = null;
  localPublicKeyFile = null;
}

// -----------------------------------------------------------------------------
// cosign
// -----------------------------------------------------------------------------

/**
 * Run cosign. Its TUF cache normally lives under $HOME, which is read-only in
 * this container — point it at scratch (nothing here contacts public Sigstore).
 * stderr is kept for the error message only; it never carries key material.
 */
function cosign(args: string[], env: Record<string, string>, opts: { captureStdout?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('cosign', args, {
      timeout: config.pluginSigning.timeoutMs,
      maxBuffer: opts.captureStdout ? MAX_STDOUT_BYTES : MAX_STDERR_BYTES,
      env: { ...process.env, TUF_ROOT: path.join(os.tmpdir(), 'pb-sigstore'), ...env },
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message).trim().split('\n').slice(-5).join(' | ');
        const message = `cosign ${args[0]} failed: ${detail}`;
        // A numeric exit code (and no kill) means cosign ran and rejected;
        // ENOENT / a timeout kill is infrastructure.
        const exited = typeof (err as { code?: unknown }).code === 'number' && !(err as { killed?: boolean }).killed;
        reject(exited ? new CosignRejectedError(message) : new PluginSigningError(message));
        return;
      }
      resolve(String(stdout ?? ''));
    });
  });
}

function registryFlags(): string[] {
  return config.registry.http || config.registry.insecure
    ? ['--allow-insecure-registry', ...(config.registry.http ? ['--allow-http-registry'] : [])]
    : [];
}

/**
 * A throwaway `$DOCKER_CONFIG` whose only credential is a management bearer
 * token for pull+push on `repository` — passed as `registrytoken`, which
 * cosign's registry client sends as `Authorization: Bearer` directly, so no
 * token-realm round trip is needed. Caller removes the directory.
 */
async function writeRepositoryCredential(repository: string, access: 'push' | 'pull' = 'push'): Promise<string> {
  const token = access === 'push' ? await mintRepositoryPushToken(repository) : await mintRepositoryPullToken(repository);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-signcfg-'));
  const host = `${config.registry.host}:${config.registry.port}`;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auths: { [host]: { registrytoken: token } } }));
  return dir;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface SignPluginImageParams {
  /** Namespace-relative repository: `system/<name>`, `org-<orgId>/<name>` or `public/<handle>/<name>`. */
  repository: string;
  /** The pushed digest to sign (`sha256:…`). */
  digest: string;
  /** SPDX JSON SBOM of that digest, attached as a signed attestation. */
  sbom: Record<string, unknown>;
  /**
   * Signed annotations (`cosign sign -a k=v`) — the public namespace records the
   * trust tier and publisher here (`pb.trust`, `pb.publisher`), so a tier edited
   * in the database without a re-sign no longer matches what verifies.
   */
  annotations?: Record<string, string>;
}

/** Signed-annotation keys the public namespace carries. */
export const TRUST_ANNOTATION = 'pb.trust';
export const PUBLISHER_ANNOTATION = 'pb.publisher';

function annotationArgs(annotations: Record<string, string> | undefined): string[] {
  return Object.entries(annotations ?? {}).flatMap(([k, v]) => ['-a', `${k}=${v}`]);
}

function refOf(repository: string, digest: string): string {
  return `${config.registry.host}:${config.registry.port}/${repository}@${digest}`;
}

function assertSignable(repository: string, digest: string): void {
  if (!isPluginRepository(repository)) throw new PluginSigningError(`Not a plugin repository: ${repository}`);
  if (!isSha256Digest(digest)) throw new PluginSigningError(`Malformed digest: ${digest}`);
}

/** Run one cosign step under a throwaway repository-scoped credential. */
async function withCredential<T>(repository: string, access: 'push' | 'pull', fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dockerConfigDir = await writeRepositoryCredential(repository, access);
  try {
    return await fn({ DOCKER_CONFIG: dockerConfigDir });
  } finally {
    fs.rmSync(dockerConfigDir, { recursive: true, force: true });
  }
}

/**
 * Remove the existing cosign signature manifest (`sha256-<hex>.sig`) of
 * `repository@digest`, so the next `cosign sign` leaves exactly ONE signature
 * — the one carrying the current annotations. cosign APPENDS signatures, so
 * without this a re-sign would leave the old tier verifying alongside the new.
 */
async function dropSignature(repository: string, digest: string): Promise<void> {
  const tag = `sha256-${digest.slice('sha256:'.length)}.sig`;
  const existing = await headManifest(repository, tag);
  if (!existing) return;
  try {
    await deleteManifest(repository, existing.digest);
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status !== 404) throw err;
  }
}

/**
 * Sign `repository@digest` and attach `sbom` as a signed SPDX attestation.
 * The caller has already confirmed the manifest exists in the repository.
 *
 * In the public namespace the signature is REPLACED rather than appended
 * (exactly one signature, carrying the current annotations) and the SBOM
 * attestation is written with `--replace`, so re-publishing is idempotent.
 */
export async function signPluginImage({ repository, digest, sbom, annotations }: SignPluginImageParams): Promise<void> {
  assertSignable(repository, digest);

  const key = await signingKey();
  const ref = refOf(repository, digest);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-sign-'));
  const predicate = path.join(workDir, 'sbom.spdx.json');
  fs.writeFileSync(predicate, JSON.stringify(sbom));
  const isPublic = isPublicRepository(repository);

  try {
    if (isPublic) await dropSignature(repository, digest);
    // One short-lived credential per cosign step — each is bounded by the
    // signing timeout, and a registry token only lives a few minutes.
    for (const args of [
      ['sign', '--key', key.key, ...annotationArgs(annotations), ...COSIGN_SIGN_FLAGS, '--yes', ...registryFlags(), ref],
      ['attest', '--key', key.key, '--type', 'spdxjson', '--predicate', predicate,
        ...(isPublic ? ['--replace'] : []), ...COSIGN_SIGN_FLAGS, '--yes', ...registryFlags(), ref],
    ]) {
      await withCredential(repository, 'push', (env) => cosign(args, { ...env, ...key.env }));
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  logger.info('Signed plugin image', { repository, digest, mode: config.pluginSigning.mode, annotated: !!annotations });
}

/**
 * Re-sign an already-published `public/*` image with new annotations (tier
 * change, publisher suspension / unsuspension, ownership transfer). The SBOM
 * attestation is untouched — it describes the content, which didn't change.
 * Idempotent: the previous signature is replaced, never stacked.
 */
export async function resignPublicImage(repository: string, digest: string, annotations: Record<string, string>): Promise<void> {
  assertSignable(repository, digest);
  if (!isPublicRepository(repository)) throw new PluginSigningError(`Not a public repository: ${repository}`);
  const key = await signingKey();
  await dropSignature(repository, digest);
  await withCredential(repository, 'push', (env) => cosign(
    ['sign', '--key', key.key, ...annotationArgs(annotations), ...COSIGN_SIGN_FLAGS, '--yes', ...registryFlags(), refOf(repository, digest)],
    { ...env, ...key.env },
  ));
  logger.info('Re-signed public plugin image', { repository, digest });
}

/**
 * Read the SPDX SBOM of `repository@digest` from its SIGNED attestation —
 * verified against the plugin-signing key, so what is re-attested in `public/*`
 * is exactly what the platform generated and signed at build time (a caller
 * can't substitute its own). Throws {@link CosignRejectedError} when no SPDX
 * attestation verifies.
 */
export async function readSignedSbom(repository: string, digest: string): Promise<Record<string, unknown>> {
  assertSignable(repository, digest);
  const key = verificationKeyRef();
  const out = await withCredential(repository, 'pull', (env) => cosign(
    ['verify-attestation', '--key', key, '--type', 'spdxjson', ...COSIGN_VERIFY_FLAGS, ...registryFlags(), refOf(repository, digest)],
    env,
    { captureStdout: true },
  ));
  const predicate = extractSpdxPredicate(out);
  if (!predicate) throw new CosignRejectedError(`No SPDX SBOM attestation verifies for ${repository}@${digest}`);
  return predicate;
}

/**
 * The SPDX predicate of the LAST verified attestation in cosign's output, or
 * null when none verifies.
 *
 * The parse itself is api-core's shared `extractPredicate` (one implementation
 * for both services that read cosign attestations). Only the NOT-FOUND POLICY
 * is image-registry's own: the caller decides what "no SBOM" means, so this
 * returns null rather than throwing.
 */
export function extractSpdxPredicate(stdout: string): Record<string, unknown> | null {
  return extractPredicate(stdout, SPDX_PREDICATE_TYPE);
}

/** One verified cosign simple-signing payload, reduced to what callers use. */
export interface VerifiedSignature {
  /** `critical.identity.docker-reference` — the repository the signature was made for. */
  dockerReference?: string;
  /** `critical.image.docker-manifest-digest`. */
  manifestDigest?: string;
  /** `optional` — the `-a k=v` annotations. */
  annotations: Record<string, string>;
}

/**
 * Verify `repository@digest`'s signature against the plugin-signing key and
 * return every verified payload. Returns `[]` when nothing verifies (cosign
 * rejected); throws {@link PluginSigningError} on an infrastructure failure.
 */
export async function verifyPluginSignature(repository: string, digest: string): Promise<VerifiedSignature[]> {
  assertSignable(repository, digest);
  const key = verificationKeyRef();
  let out: string;
  try {
    out = await withCredential(repository, 'pull', (env) => cosign(
      ['verify', '--key', key, ...COSIGN_VERIFY_FLAGS, '--output', 'json', ...registryFlags(), refOf(repository, digest)],
      env,
      { captureStdout: true },
    ));
  } catch (err) {
    if (err instanceof CosignRejectedError) return [];
    throw err;
  }
  return parseVerifyOutput(out);
}

/** Parse `cosign verify --output json` (a JSON array of simple-signing payloads). */
export function parseVerifyOutput(stdout: string): VerifiedSignature[] {
  const start = stdout.indexOf('[');
  if (start === -1) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, stdout.lastIndexOf(']') + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((p) => {
    const payload = (p ?? {}) as {
      critical?: { identity?: { 'docker-reference'?: unknown }; image?: { 'docker-manifest-digest'?: unknown } };
      optional?: Record<string, unknown> | null;
    };
    const annotations: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload.optional ?? {})) {
      if (typeof v === 'string') annotations[k] = v;
    }
    const ref = payload.critical?.identity?.['docker-reference'];
    const md = payload.critical?.image?.['docker-manifest-digest'];
    return {
      ...(typeof ref === 'string' && { dockerReference: ref }),
      ...(typeof md === 'string' && { manifestDigest: md }),
      annotations,
    };
  });
}
