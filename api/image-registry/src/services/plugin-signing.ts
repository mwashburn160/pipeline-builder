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
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import { createLogger } from '@pipeline-builder/api-core';

import { mintRepositoryPushToken } from './registry-client.js';
import { config } from '../config/index.js';

const logger = createLogger('plugin-signing');

/** Only plugin repositories are signed: `system/<name>` or `org-<orgId>/<name>`. */
const PLUGIN_REPO_RE = /^(system|org-[a-z0-9]+)\/[a-z0-9][a-z0-9._-]*$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_STDERR_BYTES = 1024 * 1024;

export class PluginSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginSigningError';
  }
}

export function isPluginRepository(repository: string): boolean {
  return PLUGIN_REPO_RE.test(repository);
}

export function isSha256Digest(digest: string): boolean {
  return DIGEST_RE.test(digest);
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
 * generates a plain PKCS#8 PEM (openssl, like every other key in deploy/). So
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

/** @internal Reset the imported-key memo (tests only). */
export function _resetPluginSigningState(): void {
  localKeyImport = null;
}

// -----------------------------------------------------------------------------
// cosign
// -----------------------------------------------------------------------------

/**
 * Run cosign. Its TUF cache normally lives under $HOME, which is read-only in
 * this container — point it at scratch (nothing here contacts public Sigstore).
 * stderr is kept for the error message only; it never carries key material.
 */
function cosign(args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('cosign', args, {
      timeout: config.pluginSigning.timeoutMs,
      maxBuffer: MAX_STDERR_BYTES,
      env: { ...process.env, TUF_ROOT: path.join(os.tmpdir(), 'pb-sigstore'), ...env },
    }, (err, _stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message).trim().split('\n').slice(-5).join(' | ');
        reject(new PluginSigningError(`cosign ${args[0]} failed: ${detail}`));
        return;
      }
      resolve();
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
async function writeRepositoryCredential(repository: string): Promise<string> {
  const token = await mintRepositoryPushToken(repository);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-signcfg-'));
  const host = `${config.registry.host}:${config.registry.port}`;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auths: { [host]: { registrytoken: token } } }));
  return dir;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface SignPluginImageParams {
  /** Namespace-relative repository: `system/<name>` or `org-<orgId>/<name>`. */
  repository: string;
  /** The pushed digest to sign (`sha256:…`). */
  digest: string;
  /** SPDX JSON SBOM of that digest, attached as a signed attestation. */
  sbom: Record<string, unknown>;
}

/**
 * Sign `repository@digest` and attach `sbom` as a signed SPDX attestation.
 * The caller has already confirmed the manifest exists in the repository.
 */
export async function signPluginImage({ repository, digest, sbom }: SignPluginImageParams): Promise<void> {
  if (!isPluginRepository(repository)) throw new PluginSigningError(`Not a plugin repository: ${repository}`);
  if (!isSha256Digest(digest)) throw new PluginSigningError(`Malformed digest: ${digest}`);

  const key = await signingKey();
  const ref = `${config.registry.host}:${config.registry.port}/${repository}@${digest}`;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-sign-'));
  const predicate = path.join(workDir, 'sbom.spdx.json');
  fs.writeFileSync(predicate, JSON.stringify(sbom));

  try {
    // One short-lived credential per cosign step — each is bounded by the
    // signing timeout, and a registry token only lives a few minutes.
    for (const args of [
      ['sign', '--key', key.key, '--tlog-upload=false', '--yes', ...registryFlags(), ref],
      ['attest', '--key', key.key, '--type', 'spdxjson', '--predicate', predicate, '--tlog-upload=false', '--yes', ...registryFlags(), ref],
    ]) {
      const dockerConfigDir = await writeRepositoryCredential(repository);
      try {
        await cosign(args, { DOCKER_CONFIG: dockerConfigDir, ...key.env });
      } finally {
        fs.rmSync(dockerConfigDir, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  logger.info('Signed plugin image', { repository, digest, mode: config.pluginSigning.mode });
}
