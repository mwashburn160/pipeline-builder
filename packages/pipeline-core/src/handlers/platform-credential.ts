// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * The platform credential a deployed Lambda holds: an opaque service-account key
 * (`pb_sa_…`), stored in the `password` field of the Secrets Manager secret that
 * `pipeline-manager infra store-token` writes. `password` stays the canonical
 * field because CodeBuild's `secretsManagerCredentials` reads the same one.
 *
 * Dependency-free apart from the Secrets Manager client so every Lambda bundle
 * can import it without dragging in aws-cdk-lib.
 */

/** Access-key prefixes platform issues. A stored JWT is NOT one of these. */
export const ACCESS_KEY_PREFIXES: readonly string[] = ['pb_sa_', 'pb_pat_'];

/** True for an HTTP status that means "this credential was refused". */
export function isCredentialRefusal(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/**
 * Refuse anything that is not an opaque access key, naming where it came from.
 * A stored JWT would otherwise surface much later as an opaque 401 from the API,
 * several layers away from the secret an operator has to fix.
 */
export function assertAccessKey(value: string, source: string): void {
  if (ACCESS_KEY_PREFIXES.some((p) => value.startsWith(p))) return;
  const looksLikeJwt = value.split('.').length === 3;
  throw new Error(
    `${source} does not hold an opaque access key (expected a "pb_sa_…" value)`
    + (looksLikeJwt
      ? ' — it holds a JWT, not a service-account key. Re-run "pipeline-manager infra store-token" to issue one.'
      : '.'),
  );
}

/** Read and parse a Secrets Manager secret holding a JSON credential record. */
export async function readCredentialSecret<T extends Record<string, unknown>>(
  secretName: string,
  client: Pick<SecretsManagerClient, 'send'> = new SecretsManagerClient({}),
): Promise<T> {
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!response.SecretString) throw new Error(`Secret "${secretName}" is empty`);
  return JSON.parse(response.SecretString) as T;
}

/** Read the `pb_sa_…` key from a credential secret, refusing a missing or non-key value. */
export async function readAccessKeyFromSecret(secretName: string): Promise<string> {
  const secret = await readCredentialSecret<{ password?: unknown }>(secretName);
  const key = typeof secret.password === 'string' ? secret.password : '';
  if (!key) {
    throw new Error(`Secret "${secretName}" missing password — run "pipeline-manager infra store-token" to provision a service-account key`);
  }
  assertAccessKey(key, `secret "${secretName}"`);
  return key;
}

export interface PlatformCredential {
  /** The cached key, read from the secret on first use (or after {@link invalidate}). */
  getKey(): Promise<string>;
  /**
   * Forget the cached key after the API refused it (401/403). The token-renew
   * Lambda rotates the secret and then revokes the predecessor, so a warm
   * container that kept its cached key would present the retired one forever.
   * The next {@link getKey} re-reads the secret and picks up the replacement.
   */
  invalidate(): void;
  /** Forget everything, including an env-provided key (tests). */
  reset(): void;
}

/**
 * A per-container cached platform credential. `envKeyVar` names an optional env
 * var holding the key directly; an env-provided key cannot change without a new
 * container, so {@link PlatformCredential.invalidate} keeps it.
 */
export function createPlatformCredential(opts: {
  /** The secret name, or a getter read at first use (env set after module load). */
  secretName?: string | (() => string | undefined);
  envKeyVar?: string;
}): PlatformCredential {
  let cached: string | null = null;
  let fromEnv = false;
  return {
    async getKey(): Promise<string> {
      if (cached) return cached;
      const direct = opts.envKeyVar ? process.env[opts.envKeyVar] : undefined;
      if (direct) {
        assertAccessKey(direct, opts.envKeyVar!);
        cached = direct;
        fromEnv = true;
        return cached;
      }
      const secretName = typeof opts.secretName === 'function' ? opts.secretName() : opts.secretName;
      if (!secretName) {
        throw new Error(`${opts.envKeyVar ? `${opts.envKeyVar} or ` : ''}PLATFORM_SECRET_NAME environment variable is required`);
      }
      cached = await readAccessKeyFromSecret(secretName);
      fromEnv = false;
      return cached;
    },
    invalidate(): void {
      if (!fromEnv) cached = null;
    },
    reset(): void {
      cached = null;
      fromEnv = false;
    },
  };
}
