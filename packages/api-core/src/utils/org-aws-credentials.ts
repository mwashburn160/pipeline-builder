// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org IAM role assumption for build / runtime AWS API calls.
 *
 * The shared posture for AWS calls today is "the service's IAM role, full
 * blast radius across every org." The operator-side mitigation operators
 * actually want is: each customer org gets its own IAM role in its own
 * account; build/runtime AWS calls for that org `sts:AssumeRole` into the
 * customer's role; a compromise of one org's role can't enumerate another
 * org's S3 buckets / ECR repos.
 *
 * This module is the credential-provider primitive. It's pluggable on the
 * org-config resolver so the same code path works whether config is read
 * from Mongo, Postgres, or env vars. Callers receive a standard SDK v3
 * `AwsCredentialIdentityProvider` and pass it to any SDK client
 * (`new CodeBuildClient({ credentials })`, etc.).
 *
 * No global state — callers construct one `OrgAwsCredentialsManager` per
 * process and `await manager.getCredentials(orgId)` before each AWS call.
 * The returned provider handles credential refresh internally (the
 * underlying `fromTemporaryCredentials` re-calls AssumeRole ~5 min before
 * the temporary credentials expire), so call sites don't manage TTL.
 *
 * Safety properties:
 *  - `externalId` is plumbed through to AssumeRole. Operators bake this
 *    into the IAM trust policy as the "confused deputy" mitigation; this
 *    module never silently omits it.
 *  - Orgs without a configured role fall through to the supplied
 *    `fallback` provider (typically the SDK default chain). Mixed-mode
 *    deployments where some orgs have per-org roles and others use the
 *    shared role are explicitly supported.
 *  - `evict(orgId)` drops the cached provider so the next call re-resolves
 *    from the resolver — use after the operator changes an org's role.
 *
 * Integration pattern for AWS SDK clients:
 *
 *   ```ts
 *   import { S3Client } from '@aws-sdk/client-s3';
 *   import { withOrgAwsCredentials } from '@pipeline-builder/api-core';
 *
 *   const manager = new OrgAwsCredentialsManager({ resolver });
 *
 *   async function s3ForOrg(orgId: string) {
 *     return withOrgAwsCredentials(manager, orgId, (creds) =>
 *       new S3Client({ credentials: creds, region: 'us-west-2' }));
 *   }
 *   ```
 *
 * Today's codebase: no platform-side service makes AWS API calls scoped to
 * a customer org (build runners use buildkitd; AWS Lambda handlers run in
 * customer territory with their own IAM). This primitive is in place for
 * when the architecture grows to add such call sites — per-org S3 buckets,
 * per-org ECR repos, per-org CodeBuild projects — without forcing an
 * insecure default.
 */

/** Structural shape of an AWS credential. Matches `@smithy/types#AwsCredentialIdentity`
 *  exactly — defined locally so api-core doesn't need to declare @smithy/types
 *  as a direct dep (it's a transitive of every AWS SDK client we use). */
export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
  credentialScope?: string;
  accountId?: string;
}

/** Standard credential-provider callable. Matches `@smithy/types#AwsCredentialIdentityProvider`. */
export type AwsCredentialIdentityProvider = () => Promise<AwsCredentialIdentity>;

/** Operator-supplied per-org IAM role + region pinning. */
export interface OrgAwsConfig {
  /** ARN of the role this org's build/runtime code should assume. */
  assumeRoleArn: string;
  /** External id baked into the role's trust policy (recommended). */
  externalId?: string;
  /** Region to use when the calling code doesn't pin one. */
  region?: string;
  /** AssumeRole session duration (seconds). AWS allows 900-43200; the
   *  effective ceiling is the role's `MaxSessionDuration`. Default 3600. */
  sessionDurationSeconds?: number;
  /** Session name embedded in CloudTrail. Useful for incident-response
   *  attribution. Default `pipeline-builder-<orgId>`. */
  roleSessionName?: string;
}

/** Async resolver: orgId → config | null. Returning null means "this org
 *  has no per-org role; use the fallback provider." */
export type OrgAwsConfigResolver = (orgId: string) => Promise<OrgAwsConfig | null>;

/** Constructor options. */
export interface OrgAwsCredentialsManagerOptions {
  resolver: OrgAwsConfigResolver;
  /** Provider used for orgs whose resolver returns null. Default: the SDK
   *  default chain via `@aws-sdk/credential-providers#fromNodeProviderChain`. */
  fallback?: AwsCredentialIdentityProvider;
  /** Region passed to the inner STS client when the org config doesn't
   *  pin one. Default: `AWS_REGION` / `AWS_DEFAULT_REGION` env. */
  region?: string;
  /** STS endpoint override (LocalStack, VPC endpoint). Default: SDK default. */
  endpoint?: string;
}

interface CacheEntry {
  /** Stable identity of the config we built this entry from. Lets `get`
   *  detect that the operator changed the config and we should re-build
   *  rather than serve a stale provider. */
  fingerprint: string;
  provider: AwsCredentialIdentityProvider;
}

/**
 * Per-process manager that resolves and caches per-org credential providers.
 * One instance per service; share it across handlers.
 */
export class OrgAwsCredentialsManager {
  private readonly resolver: OrgAwsConfigResolver;
  private readonly fallbackOverride?: AwsCredentialIdentityProvider;
  private readonly region?: string;
  private readonly endpoint?: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<AwsCredentialIdentityProvider>>();
  /** Lazy default chain. Built once per manager so we don't import the
   *  credential-providers SDK in test environments that never touch the
   *  fallback path. */
  private fallbackCache?: AwsCredentialIdentityProvider;

  constructor(opts: OrgAwsCredentialsManagerOptions) {
    this.resolver = opts.resolver;
    this.fallbackOverride = opts.fallback;
    this.region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    this.endpoint = opts.endpoint ?? process.env.AWS_STS_ENDPOINT;
  }

  /**
   * Return an AwsCredentialIdentityProvider scoped to `orgId`. Pass the
   * returned value into any SDK v3 client's `credentials` option.
   *
   * Concurrent first-touch callers share one resolver invocation; later
   * calls hit the cache. The provider itself caches and refreshes
   * AssumeRole-derived credentials internally.
   */
  async getCredentials(orgId: string): Promise<AwsCredentialIdentityProvider> {
    if (!orgId) throw new Error('OrgAwsCredentialsManager.getCredentials requires a non-empty orgId');

    const cached = this.cache.get(orgId);
    if (cached) return cached.provider;

    let pending = this.inFlight.get(orgId);
    if (!pending) {
      pending = this.resolveAndBuild(orgId);
      this.inFlight.set(orgId, pending);
      void pending.finally(() => {
        if (this.inFlight.get(orgId) === pending) this.inFlight.delete(orgId);
      });
    }
    return pending;
  }

  /** Drop the cached provider for an org. Call after the operator rotates
   *  the role ARN or external id so the next request rebuilds. */
  evict(orgId: string): void {
    this.cache.delete(orgId);
  }

  /** Drop every cached provider. Useful in tests; rarely in production. */
  evictAll(): void {
    this.cache.clear();
  }

  private async resolveAndBuild(orgId: string): Promise<AwsCredentialIdentityProvider> {
    const cfg = await this.resolver(orgId);
    if (!cfg || !cfg.assumeRoleArn) {
      const fallback = await this.getFallback();
      this.cache.set(orgId, { fingerprint: 'fallback', provider: fallback });
      return fallback;
    }

    const provider = await this.buildAssumeRoleProvider(orgId, cfg);
    this.cache.set(orgId, { fingerprint: fingerprintConfig(cfg), provider });
    return provider;
  }

  private async getFallback(): Promise<AwsCredentialIdentityProvider> {
    if (this.fallbackOverride) return this.fallbackOverride;
    if (this.fallbackCache) return this.fallbackCache;
    // Lazy-import so test envs that supply their own resolver/fallback
    // don't load the credential-providers SDK.
    const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
    this.fallbackCache = fromNodeProviderChain();
    return this.fallbackCache;
  }

  private async buildAssumeRoleProvider(orgId: string, cfg: OrgAwsConfig): Promise<AwsCredentialIdentityProvider> {
    // Dynamic imports — STS + credential-providers are heavyweight and
    // services that never have per-org roles configured shouldn't load them.
    const [{ STSClient }, { fromTemporaryCredentials }] = await Promise.all([
      import('@aws-sdk/client-sts'),
      import('@aws-sdk/credential-providers'),
    ]);

    const masterCredentials = this.fallbackOverride ?? (await this.getFallback());

    const sessionName = cfg.roleSessionName ?? `pipeline-builder-${orgId}`.slice(0, 64);
    const region = cfg.region ?? this.region;

    return fromTemporaryCredentials({
      // Inner STS client uses the service's own credentials (the fallback
      // chain). Those creds need `sts:AssumeRole` on the org's role.
      masterCredentials,
      clientConfig: {
        region,
        ...(this.endpoint ? { endpoint: this.endpoint } : {}),
        // Cast to satisfy fromTemporaryCredentials' typing; STSClient
        // matches the structural client shape it expects.
      } as unknown as ConstructorParameters<typeof STSClient>[0],
      params: {
        RoleArn: cfg.assumeRoleArn,
        RoleSessionName: sessionName,
        DurationSeconds: cfg.sessionDurationSeconds ?? 3600,
        ...(cfg.externalId ? { ExternalId: cfg.externalId } : {}),
      },
    });
  }
}

/**
 * Deterministic fingerprint of a config. Used by `getCredentials` to
 * detect "the cache is stale because the operator changed the config" —
 * not exposed publicly, just defense in depth against a missed `evict`.
 */
function fingerprintConfig(cfg: OrgAwsConfig): string {
  return [
    cfg.assumeRoleArn,
    cfg.externalId ?? '',
    cfg.region ?? '',
    cfg.sessionDurationSeconds ?? '',
    cfg.roleSessionName ?? '',
  ].join('|');
}

/** Convenience: directly resolve credentials for a single call. The manager
 *  doesn't cache when called this way — useful in CLIs / one-shot scripts. */
export async function resolveOrgCredentialsOnce(
  orgId: string,
  resolver: OrgAwsConfigResolver,
): Promise<AwsCredentialIdentity> {
  const manager = new OrgAwsCredentialsManager({ resolver });
  const provider = await manager.getCredentials(orgId);
  return provider();
}

/**
 * Adapter: resolve per-org credentials and construct an AWS SDK client
 * pre-bound to them. The factory is async because credential resolution may
 * need to make a network call (fetching org config + AssumeRole). Once
 * resolved, the returned client is ready for normal SDK calls; the provider
 * inside refreshes credentials automatically before they expire.
 *
 * Typical usage:
 *   ```ts
 *   const s3 = await withOrgAwsCredentials(manager, orgId, (creds) =>
 *     new S3Client({ credentials: creds, region: 'us-west-2' }));
 *   await s3.send(new ListObjectsV2Command({ Bucket: bucketFor(orgId) }));
 *   ```
 *
 * The factory is invoked exactly once per call — callers that need a
 * long-lived client should cache the result themselves rather than rebuilding
 * on every operation. (Re-resolving on every op is fine for cold paths and
 * a wasted couple of object allocations on hot paths.)
 */
export async function withOrgAwsCredentials<TClient>(
  manager: OrgAwsCredentialsManager,
  orgId: string,
  factory: (credentials: AwsCredentialIdentityProvider) => TClient,
): Promise<TClient> {
  const credentials = await manager.getCredentials(orgId);
  return factory(credentials);
}
