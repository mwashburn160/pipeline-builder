// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { envInt } from '@pipeline-builder/api-core';

/**
 * Resolve an env-supplied secret material to its raw value. The convention
 * across our services is `_FILE` suffixed env vars point at a path on disk
 * (Docker/K8s secrets); the bare env var is the literal value. Either is
 * acceptable; both cannot be set.
 */
function resolveSecretValue(name: string, required = true): string {
  const direct = process.env[name];
  const filePath = process.env[`${name}_FILE`];

  if (direct && filePath) {
    throw new Error(`${name} and ${name}_FILE both set — pick one`);
  }
  if (filePath) {
    return readFileSync(filePath, 'utf-8').trimEnd();
  }
  if (direct) {
    return direct;
  }
  if (required) {
    throw new Error(`${name} (or ${name}_FILE) must be set`);
  }
  return '';
}

export interface AppConfig {
  /** HTTP listen port (env: `PORT`). */
  readonly port: number;

  /** Underlying Docker registry the service proxies to. */
  readonly registry: {
    readonly host: string;
    readonly port: number;
    /** Use http:// instead of https:// (env: `IMAGE_REGISTRY_HTTP`). */
    readonly http: boolean;
    /** Skip TLS cert verification (self-signed registries; env: `IMAGE_REGISTRY_INSECURE`). */
    readonly insecure: boolean;
  };

  /**
   * RS256 signing key for issued registry tokens. The corresponding x509
   * cert is what the registry verifies against (mounted at the registry's
   * `REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE`).
   */
  readonly tokenSigning: {
    readonly privateKeyPem: string;
    /** Certificate the registry trusts; base64-DER'd into the JWT `x5c` header so registry v3 verifies the token against its rootcertbundle. */
    readonly certificatePem: string;
    /** `iss` claim on issued tokens. Must match the registry's `REGISTRY_AUTH_TOKEN_ISSUER`. */
    readonly issuer: string;
    /** `aud`/`service` value. Must match the registry's `REGISTRY_AUTH_TOKEN_SERVICE`. */
    readonly service: string;
    /** Token lifetime in seconds. */
    readonly expiresInSeconds: number;
  };

  // Platform JWTs presented as the Basic-auth password (customer CodeBuild, the
  // plugin-lookup Lambda) are verified against platform's PUBLISHED ES256 keys
  // via api-core's JWKS cache — see `services/auth-resolver.ts`. There is no
  // verification material to configure here any more. Internal SERVICE tokens
  // are verified against the per-service public bundle — this service
  // holds only its OWN signing key, and no key here can mint a platform token.

  /**
   * Platform service, reached IN-CLUSTER for the `docker login` flow
   * (auth-resolver Path 2): Basic auth whose password isn't a JWT is forwarded
   * to platform's `/auth/login`. Same `PLATFORM_SERVICE_HOST`/`_PORT` every other
   * service uses to call platform (billing, message, remote audit) — NOT the
   * public `PLATFORM_BASE_URL`, which is the ingress URL (with an `/api` prefix
   * that the platform service itself doesn't serve).
   */
  readonly platformService: {
    readonly host: string;
    readonly port: number;
  };

  /**
   * The plugin-signing key. This service is the ONLY holder: the plugin build
   * worker asks it to sign every pushed plugin image (`/internal/plugin-signatures`)
   * rather than hold the key itself, because the plugin pod shares its network
   * namespace with untrusted tenant builds (see api/plugin supply-chain.ts).
   *
   * - `local` — EC P-256 PKCS PEM on disk (env: `PLUGIN_SIGNING_KEY_FILE`).
   * - `kms` — an AWS KMS `ECC_NIST_P256` `SIGN_VERIFY` key, BY ALIAS
   *             (env: `PLUGIN_SIGNING_KMS_KEY_ID`); an ARN embeds the account id.
   */
  readonly pluginSigning: {
    readonly mode: 'local' | 'kms';
    readonly keyFile: string;
    readonly kmsKeyId: string;
    /** Upper bound on one cosign invocation (env: `PLUGIN_SIGNING_TIMEOUT_MS`). */
    readonly timeoutMs: number;
  };
}

export function loadConfig(): AppConfig {
  if (!process.env.IMAGE_REGISTRY_HOST) {
    throw new Error('IMAGE_REGISTRY_HOST environment variable is required');
  }

  return {
    port: envInt('PORT', 3000, { min: 1, max: 65535 }),

    registry: {
      host: process.env.IMAGE_REGISTRY_HOST,
      port: envInt('IMAGE_REGISTRY_PORT', 5000, { min: 1, max: 65535 }),
      http: process.env.IMAGE_REGISTRY_HTTP === 'true',
      insecure: process.env.IMAGE_REGISTRY_INSECURE === 'true',
    },

    tokenSigning: {
      privateKeyPem: resolveSecretValue('REGISTRY_TOKEN_PRIVATE_KEY'),
      certificatePem: resolveSecretValue('REGISTRY_TOKEN_CERTIFICATE'),
      issuer: process.env.REGISTRY_TOKEN_ISSUER || 'platform',
      service: process.env.REGISTRY_TOKEN_SERVICE || 'pipeline-image-registry',
      expiresInSeconds: envInt('REGISTRY_TOKEN_EXPIRES_IN', 300, { min: 1 }),
    },

    platformService: {
      host: process.env.PLATFORM_SERVICE_HOST || 'platform',
      port: envInt('PLATFORM_SERVICE_PORT', 3000, { min: 1, max: 65535 }),
    },

    pluginSigning: {
      mode: process.env.PLUGIN_SIGNING_MODE === 'kms' ? 'kms' : 'local',
      keyFile: process.env.PLUGIN_SIGNING_KEY_FILE || '/etc/pipeline-builder/plugin-signing/plugin-signing.key',
      kmsKeyId: process.env.PLUGIN_SIGNING_KMS_KEY_ID || '',
      timeoutMs: envInt('PLUGIN_SIGNING_TIMEOUT_MS', 120_000, { min: 1 }),
    },
  };
}

export const config: AppConfig = loadConfig();
