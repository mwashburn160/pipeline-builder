// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin image supply chain: SBOM, signature, verification.
 *
 * After every push (built or uploaded) the worker, still holding the push
 * credential, runs {@link attachSupplyChain}:
 *   1. `syft` scans the pushed image BY DIGEST → SPDX JSON SBOM
 *   2. image-registry (`POST /internal/plugin-signatures`) signs that digest and
 *      attaches the SBOM as a signed in-toto attestation.
 * A failure in either step fails the build — an image that can't be signed
 * never reaches the catalog. For a BuildKit build the pushed digest is an image
 * index that also holds BuildKit's SLSA provenance, so the one signature covers
 * the image and its provenance together.
 *
 * WHY the signing happens in image-registry, not here: this pod's network
 * namespace is shared with the buildkitd sidecar, which runs untrusted tenant
 * Dockerfile `RUN` steps. Any AWS credential endpoint (Pod Identity agent, IMDS)
 * this pod could reach, a tenant build could reach too — and use to `kms:Sign`
 * arbitrary images with the platform key. So the private key (file or KMS)
 * lives only in image-registry, and this service holds just the PUBLIC key.
 *
 * `/plugins/lookup` — the endpoint synth resolves plugins through — runs
 * {@link verifyImageSignature} before returning an image-producing plugin, and
 * synth pins CodeBuild to the verified digest. The registry has no immutable
 * tags and a CodeBuild credential can push to its org's namespace, so without
 * the digest pin a re-pushed `name:version` would run unverified.
 *
 * Signing is key-based with the transparency log OFF (image-registry signs with
 * `--tlog-upload=false`, verification here uses `--insecure-ignore-tlog`): the
 * public Rekor log would publish every org id and plugin name, and the verifier
 * pins the key, which is what the tlog would otherwise vouch for. Signatures
 * live in the registry as cosign's `sha256-<digest>.sig` / `.att` tags.
 */

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import { createLogger, errorMessage, getServiceAuthHeader, InternalHttpClient } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

import { run } from './build-process.js';
import type { BuildStreamOptions } from './build-process.js';
import { imageRepository, writeAuthConfig } from './registry-auth.js';
import type { RegistryInfo } from './registry-auth.js';

const logger = createLogger('supply-chain');

/** SPDX predicate type cosign records for `--type spdxjson`. */
const SPDX_PREDICATE_TYPE = 'https://spdx.dev/Document';
/** `sha256:` + 64 lowercase hex — the only digest shape the platform stores. */
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Supply-chain steps after the push, each bounded by `pushTimeoutMs`: the SBOM
 * scan and the signing call. The push credential's TTL budgets for them.
 */
export const SUPPLY_CHAIN_STEPS = 2;

/** A verified digest is re-checked after this long (the signature tag can be deleted). */
const VERIFY_CACHE_TTL_MS = 10 * 60_000;
const VERIFY_CACHE_MAX = 2000;

/**
 * The image's signature (or signed SBOM) did not verify. Distinct from an
 * infrastructure failure so the lookup route can answer 409
 * `IMAGE_VERIFICATION_FAILED` and synth can refuse the plugin outright.
 */
export class ImageVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageVerificationError';
  }
}

function getBuildCfg() {
  return Config.get('dockerConfig');
}

function verificationKey(): string {
  const keyFile = getBuildCfg().signingPublicKeyFile;
  if (!fs.existsSync(keyFile)) {
    throw new Error(`Plugin signing public key not found at ${keyFile} (see deploy/bin/plugin-signing-keys.sh)`);
  }
  return keyFile;
}

/**
 * cosign keeps a TUF cache under $HOME, which is read-only in the plugin
 * container; point it at scratch. Nothing here talks to public Sigstore
 * (key-based, tlog off), but the cache dir must still be writable.
 */
function cosignEnv(): Record<string, string> {
  return { TUF_ROOT: path.join(os.tmpdir(), 'pb-sigstore') };
}

function cosignRegistryFlags(registry: RegistryInfo): string[] {
  return registry.http ? ['--allow-insecure-registry', '--allow-http-registry'] : [];
}

/** Namespace-relative repository (`system/<name>` / `org-<id>/<name>`) of a full one. */
function relativeRepository(repository: string, registry: RegistryInfo): string {
  const prefix = `${registry.host}:${registry.port}/`;
  if (!repository.startsWith(prefix)) throw new Error(`Repository ${repository} is not on registry ${prefix}`);
  return repository.slice(prefix.length);
}

// -----------------------------------------------------------------------------
// Attach (build side)
// -----------------------------------------------------------------------------

export interface AttachSupplyChainParams {
  /** `<host>:<port>/<ns>/<name>` — no tag. */
  repository: string;
  /** Pushed digest (`sha256:…`). */
  digest: string;
  registry: RegistryInfo;
  /** Owning org of the image (the service token that requests the signature carries it). */
  orgId: string;
  /** A `$DOCKER_CONFIG` dir holding a credential that can PULL the repository. */
  dockerConfigDir: string;
  /** Platform to scan when the digest is a multi-platform index (BuildKit builds). */
  platform?: string;
}

/** SBOM → signature + SBOM attestation, for one pushed digest. Throws on any failure. */
export async function attachSupplyChain(params: AttachSupplyChainParams, opts?: BuildStreamOptions): Promise<void> {
  const { repository, digest, registry, orgId, dockerConfigDir, platform } = params;
  if (!DIGEST_RE.test(digest)) throw new Error(`Refusing to sign malformed digest "${digest}"`);
  const cfg = getBuildCfg();
  const ref = `${repository}@${digest}`;

  // The SBOM lands beside the build scratch (the data volume sized for builds);
  // syft's layer extraction goes there too via TMPDIR, not the container's /tmp.
  const workDir = fs.mkdtempSync(path.join(cfg.tempRoot, 'pb-sbom-'));
  const sbomFile = path.join(workDir, 'sbom.spdx.json');
  let sbom: unknown;
  try {
    opts?.onLine?.(`Generating SBOM for ${ref}`, 'stdout');
    await run('syft', [
      'scan', `registry:${ref}`,
      ...(platform ? ['--platform', platform] : []),
      '-o', `spdx-json=${sbomFile}`,
      '-q',
    ], cfg.pushTimeoutMs, {
      DOCKER_CONFIG: dockerConfigDir,
      TMPDIR: workDir,
      SYFT_CHECK_FOR_APP_UPDATE: 'false',
      ...(registry.http ? { SYFT_REGISTRY_INSECURE_USE_HTTP: 'true' } : {}),
    }, opts);
    sbom = JSON.parse(fs.readFileSync(sbomFile, 'utf-8'));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  opts?.onLine?.(`Signing ${ref} and attaching its SBOM`, 'stdout');
  const services = Config.get('server').services;
  const client = new InternalHttpClient({
    host: services.imageRegistryHost,
    port: services.imageRegistryPort,
    timeout: cfg.pushTimeoutMs,
  });
  // No retries: a signature request that timed out may still have landed, and a
  // retry would just append a second signature — the build retry covers it.
  const res = await client.post<{ message?: string }>('/internal/plugin-signatures', {
    repository: relativeRepository(repository, registry),
    digest,
    sbom,
  }, {
    headers: { Authorization: getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' }) },
    maxRetries: 0,
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`image-registry refused to sign ${ref} (HTTP ${res.statusCode}): ${res.body?.message ?? 'no detail'}`);
  }
  logger.info('Plugin image signed with SBOM attestation', { ref });
}

// -----------------------------------------------------------------------------
// Verify (lookup side)
// -----------------------------------------------------------------------------

/** What identifies a plugin image to verify. */
export interface PluginImageRef {
  orgId: string;
  name: string;
  imageDigest: string | null;
}

/** digest-ref → verified-until (epoch ms). Only successes are cached. */
const verified = new Map<string, number>();
/** Concurrent lookups of one image share one cosign run. */
const inFlight = new Map<string, Promise<void>>();

/** @internal Reset the verify cache (tests only). */
export function _resetSupplyChainState(): void {
  verified.clear();
  inFlight.clear();
}

function refFor(plugin: PluginImageRef, registry: RegistryInfo): string {
  if (!plugin.imageDigest || !DIGEST_RE.test(plugin.imageDigest)) {
    throw new ImageVerificationError(
      `Plugin "${plugin.name}" has no signed image digest — rebuild it so the platform can sign it`);
  }
  return `${imageRepository(plugin.name, registry, plugin.orgId)}@${plugin.imageDigest}`;
}

/**
 * Run a read-only cosign verification with a short-lived PULL credential for
 * the plugin's owning org.
 */
async function withPullCredential<T>(plugin: PluginImageRef, registry: RegistryInfo, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const cfg = getBuildCfg();
  const dockerConfigDir = writeAuthConfig(registry, plugin.orgId, Math.ceil(cfg.pushTimeoutMs / 1000), 'pull');
  try {
    return await fn({ DOCKER_CONFIG: dockerConfigDir, ...cosignEnv() });
  } finally {
    fs.rmSync(dockerConfigDir, { recursive: true, force: true });
  }
}

/** A non-zero cosign exit is a verification failure; a spawn error or missing key is not. */
function isCosignRejection(err: unknown): boolean {
  return err instanceof Error && err.name === 'BuildProcessError';
}

/**
 * Verify the plugin image's cosign signature against the plugin-signing key.
 * Throws {@link ImageVerificationError} when it doesn't verify (or the plugin
 * has no digest); rethrows infrastructure failures as-is.
 */
export async function verifyImageSignature(plugin: PluginImageRef, registry: RegistryInfo): Promise<void> {
  const ref = refFor(plugin, registry);
  const until = verified.get(ref);
  if (until && until > Date.now()) return;

  const pending = inFlight.get(ref);
  if (pending) return pending;

  const key = verificationKey();
  const check = withPullCredential(plugin, registry, async (env) => {
    try {
      await run('cosign', [
        'verify', '--key', key, '--insecure-ignore-tlog=true',
        ...cosignRegistryFlags(registry),
        ref,
      ], getBuildCfg().pushTimeoutMs, env, { captureStdout: true });
    } catch (err) {
      if (isCosignRejection(err)) {
        logger.warn('Plugin image signature did not verify', { ref, error: errorMessage(err) });
        throw new ImageVerificationError(`Plugin "${plugin.name}" image ${plugin.imageDigest} failed signature verification`);
      }
      throw err;
    }
    if (verified.size >= VERIFY_CACHE_MAX) verified.clear();
    verified.set(ref, Date.now() + VERIFY_CACHE_TTL_MS);
  }).finally(() => { inFlight.delete(ref); });

  inFlight.set(ref, check);
  return check;
}

/**
 * Fetch the plugin image's SBOM (SPDX JSON) — from the signed attestation, so
 * what is returned is exactly what the platform generated and signed. Throws
 * {@link ImageVerificationError} when no attestation verifies.
 */
export async function fetchImageSbom(plugin: PluginImageRef, registry: RegistryInfo): Promise<Record<string, unknown>> {
  const ref = refFor(plugin, registry);
  const key = verificationKey();
  const out = await withPullCredential(plugin, registry, async (env) => {
    try {
      return await run('cosign', [
        'verify-attestation', '--key', key, '--type', 'spdxjson', '--insecure-ignore-tlog=true',
        ...cosignRegistryFlags(registry),
        ref,
      ], getBuildCfg().pushTimeoutMs, env, { captureStdout: true });
    } catch (err) {
      if (isCosignRejection(err)) {
        throw new ImageVerificationError(`Plugin "${plugin.name}" has no verified SBOM attestation`);
      }
      throw err;
    }
  });
  return extractSpdxPredicate(out, plugin.name);
}

/**
 * `cosign verify-attestation` prints one DSSE envelope per verified attestation,
 * one per line: `{ payloadType, payload: base64(in-toto statement), signatures }`.
 * Return the SPDX predicate of the LAST one (a rebuild re-attests the same
 * digest, and cosign lists attestations oldest-first).
 */
export function extractSpdxPredicate(stdout: string, pluginName: string): Record<string, unknown> {
  let predicate: Record<string, unknown> | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const envelope = JSON.parse(trimmed) as { payload?: string };
      if (!envelope.payload) continue;
      const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8')) as {
        predicateType?: string;
        predicate?: unknown;
      };
      if (statement.predicateType === SPDX_PREDICATE_TYPE && statement.predicate && typeof statement.predicate === 'object') {
        predicate = statement.predicate as Record<string, unknown>;
      }
    } catch {
      // Not an envelope line — cosign prints nothing else on stdout, but be strict
      // about what counts rather than fail on stray output.
    }
  }
  if (!predicate) throw new ImageVerificationError(`Plugin "${pluginName}" has no SPDX SBOM attestation`);
  return predicate;
}
