// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';

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
    /** Username this service uses to call the underlying registry's API for management ops. */
    readonly username: string;
    /** Password for the same. */
    readonly password: string;
  };

  /**
   * RS256 signing key for issued registry tokens. The corresponding x509
   * cert is what the registry verifies against (mounted at the registry's
   * `REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE`).
   */
  readonly tokenSigning: {
    readonly privateKeyPem: string;
    /** Certificate the registry trusts; used to compute the libtrust `kid` for the JWT header. */
    readonly certificatePem: string;
    /** `iss` claim on issued tokens. Must match the registry's `REGISTRY_AUTH_TOKEN_ISSUER`. */
    readonly issuer: string;
    /** `aud`/`service` value. Must match the registry's `REGISTRY_AUTH_TOKEN_SERVICE`. */
    readonly service: string;
    /** Token lifetime in seconds. */
    readonly expiresInSeconds: number;
  };

  /**
   * Platform's JWT verification material. Used to validate incoming Basic
   * auth where the password is a platform-issued JWT — this is the path
   * customer CodeBuild + plugin-lookup Lambda use, by reading the same
   * Secrets Manager secret platform wrote with `pipeline-manager store-token`.
   */
  readonly platformJwt: {
    readonly secret: string;
    /** `iss` claim platform stamps on its JWTs. */
    readonly issuer?: string;
    /** Permitted `aud` value(s) on platform JWTs. */
    readonly audience?: string;
  };

  /**
   * Platform service URL — used for the `docker login` flow (auth-resolver
   * Path 2). Incoming Basic auth that doesn't decode as a JWT is forwarded
   * to platform's `/auth/login`, which returns a JWT we can introspect for
   * org claims.
   *
   * Empty string disables the `docker login` path (defaults to disabled
   * to avoid surprise outbound calls during testing).
   */
  readonly platformUrl: string;
}

if (!process.env.IMAGE_REGISTRY_HOST) {
  throw new Error('IMAGE_REGISTRY_HOST environment variable is required');
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),

  registry: {
    host: process.env.IMAGE_REGISTRY_HOST,
    port: parseInt(process.env.IMAGE_REGISTRY_PORT || '5000', 10),
    http: process.env.IMAGE_REGISTRY_HTTP === 'true',
    insecure: process.env.IMAGE_REGISTRY_INSECURE === 'true',
    username: resolveSecretValue('IMAGE_REGISTRY_USERNAME'),
    password: resolveSecretValue('IMAGE_REGISTRY_PASSWORD'),
  },

  tokenSigning: {
    privateKeyPem: resolveSecretValue('REGISTRY_TOKEN_PRIVATE_KEY'),
    certificatePem: resolveSecretValue('REGISTRY_TOKEN_CERTIFICATE'),
    issuer: process.env.REGISTRY_TOKEN_ISSUER || 'platform',
    service: process.env.REGISTRY_TOKEN_SERVICE || 'pipeline-image-registry',
    expiresInSeconds: parseInt(process.env.REGISTRY_TOKEN_EXPIRES_IN || '300', 10),
  },

  platformJwt: {
    secret: resolveSecretValue('JWT_SECRET'),
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
  },

  platformUrl: process.env.PLATFORM_BASE_URL || '',
};
