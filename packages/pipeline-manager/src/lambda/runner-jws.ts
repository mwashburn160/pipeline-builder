// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Verification of the platform's SIGNED RUN REQUEST — the one thing that lets a
 * runner sitting behind a public Function URL trust what arrives there.
 *
 * Format: a compact JWS, `alg: EdDSA` (Ed25519), header
 * `{ alg: 'EdDSA', typ: 'pb-run+jwt', kid }`, signed by the runner-signing key of the
 * organization that owns this runner (its effective key org; never the
 * platform's user-token key). Public keys are served, unauthenticated, per
 * runner at `<PLATFORM_BASE_URL>` + `runnerJwksPath(RUNNER_ID)`
 * (`/api/pipelines/runner/runners/<runnerId>/jwks.json`). A 404 there (an
 * unknown or revoked runner, or an owner with no keys) means NO keys: the
 * runner then refuses every request.
 *
 * Every check fails CLOSED with {@link SignatureError} (→ 401 SIGNATURE_INVALID),
 * and all of them run before any AWS call. Node built-ins plus the
 * dependency-free contract catalog (`@pipeline-builder/api-core/pipeline-runners`,
 * inlined by the bundler), so the bundled Lambda stays one self-contained file.
 */

import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import {
  AWS_REGION_PATTERN, DEPLOY_GRANT_PATTERN, DEPLOY_IMAGE_DIGEST_PATTERN, DEPLOY_JOB_IMAGE_REPOSITORY, DEPLOY_JOB_MODES,
  RUN_REQUEST_ALG, RUN_REQUEST_CLOCK_SKEW_SECONDS, RUN_REQUEST_ISS, RUN_REQUEST_MAX_LIFETIME_SECONDS, RUN_REQUEST_TYP, RUNNER_ACTIONS,
  type DeployJobMode, type RunClaims, type RunDeployClaim, type RunnerAction,
} from '@pipeline-builder/api-core/pipeline-runners';

/** The claims a run request carries — the shared contract's. */
export type { RunClaims };
/** How long a fetched key set is trusted before it is fetched again. */
export const JWKS_TTL_MS = 10 * 60 * 1000;
/** An unknown `kid` refetches the key set at most this often. */
export const JWKS_MIN_REFETCH_MS = 60 * 1000;
/** A seen `jti` is remembered this long (longer than any request can live). */
export const REPLAY_WINDOW_MS = 15 * 60 * 1000;

/** A request that is not a valid platform-signed request for this runner. */
export class SignatureError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SignatureError';
  }
}

/** The key set could not be fetched (and none is cached) — a runner-side failure, not a bad request. */
export class JwksUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'JwksUnavailableError';
  }
}

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; redirect?: 'error'; signal?: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;

interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  kid?: string;
  use?: string;
  alg?: string;
}

/**
 * This runner's signing public keys, fetched from its own JWKS endpoint and
 * cached: trusted for {@link JWKS_TTL_MS}, refetched early when a request names
 * an unknown `kid` (a key rotation), but at most once per
 * {@link JWKS_MIN_REFETCH_MS} so a flood of bogus kids cannot turn the runner
 * into a fetch amplifier. The same throttle applies to a refresh that failed
 * while keys are cached. Redirects are refused: keys come from the configured
 * URL only.
 *
 * A 404 is an ANSWER, not an outage: the platform does not know this runner
 * (revoked, or never activated and expired) or its owner has no keys. The key
 * set becomes empty, cached keys included, so every request fails closed with
 * 401 SIGNATURE_INVALID. Any other failure keeps serving the cached keys.
 */
export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = -Infinity;
  private lastAttemptAt = -Infinity;

  constructor(
    private readonly url: string,
    private readonly fetchFn: FetchFn,
    private readonly now: () => number,
    private readonly timeoutMs = 5_000,
  ) {}

  /** The key for `kid`, or undefined when the platform does not publish it. */
  async get(kid: string): Promise<KeyObject | undefined> {
    // Never fetched: always try (a failure is a 500 the platform retries, never
    // a 401). Expired: refresh, throttled so a platform outage is not re-tried
    // on every request while the cached keys keep serving.
    const never = this.fetchedAt === -Infinity;
    if (never || (this.now() - this.fetchedAt >= JWKS_TTL_MS && this.mayRefetch())) await this.refresh();
    const key = this.keys.get(kid);
    if (key) return key;
    if (this.mayRefetch()) {
      await this.refresh();
      return this.keys.get(kid);
    }
    return undefined;
  }

  private mayRefetch(): boolean {
    return this.now() - this.lastAttemptAt >= JWKS_MIN_REFETCH_MS;
  }

  private async refresh(): Promise<void> {
    this.lastAttemptAt = this.now();
    let body: unknown;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(this.url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
        if (res.status === 404) {
          body = { keys: [] };
        } else {
          if (!res.ok) throw new Error(`JWKS endpoint answered ${res.status}`);
          body = await res.json();
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Keep serving the keys we already have: a platform blip must not take a
      // runner with a good cache offline. With nothing cached there is no way to
      // verify anything — a runner error (5xx, the platform retries), not a 401.
      if (this.keys.size > 0) return;
      throw new JwksUnavailableError(err instanceof Error ? err.message : String(err));
    }
    const next = new Map<string, KeyObject>();
    const list = (body as { keys?: unknown })?.keys;
    for (const jwk of Array.isArray(list) ? list as Jwk[] : []) {
      if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || typeof jwk.kid !== 'string') continue;
      if (jwk.use !== undefined && jwk.use !== 'sig') continue;
      if (jwk.alg !== undefined && jwk.alg !== RUN_REQUEST_ALG) continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }));
      } catch {
        // A malformed key is skipped, never trusted.
      }
    }
    this.keys = next;
    this.fetchedAt = this.now();
  }
}

function b64urlJson(part: string, what: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new SignatureError(`malformed ${what}`);
  }
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Verify a compact JWS run request and return its claims.
 *
 * `runnerId` is this runner's own id (`aud` must equal it). The CLI registers
 * the runner BEFORE deploying it, so the id is always in the stack; a runner
 * without one refuses everything — there is no "unbound" mode.
 */
export async function verifyRunRequest(
  jws: string,
  opts: { jwks: Pick<JwksCache, 'get'>; runnerId?: string; now: () => number },
): Promise<RunClaims> {
  if (typeof jws !== 'string') throw new SignatureError('missing request');
  const parts = jws.trim().split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new SignatureError('not a compact JWS');
  const [h, p, s] = parts as [string, string, string];

  const header = b64urlJson(h, 'header');
  if (header.typ !== RUN_REQUEST_TYP) throw new SignatureError('wrong typ');
  if (header.alg !== RUN_REQUEST_ALG) throw new SignatureError('wrong alg');
  if (!isNonEmptyString(header.kid)) throw new SignatureError('missing kid');
  if (header.crit !== undefined) throw new SignatureError('unsupported crit header');

  const key = await opts.jwks.get(header.kid);
  if (!key) throw new SignatureError('unknown kid');

  const signature = Buffer.from(s, 'base64url');
  let valid = false;
  try {
    valid = signature.length === 64 && cryptoVerify(null, Buffer.from(`${h}.${p}`, 'ascii'), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new SignatureError('bad signature');

  const c = b64urlJson(p, 'payload');
  if (c.iss !== RUN_REQUEST_ISS) throw new SignatureError('wrong iss');
  if (!isNonEmptyString(c.aud)) throw new SignatureError('missing aud');
  if (!isNonEmptyString(c.jti)) throw new SignatureError('missing jti');
  if (typeof c.iat !== 'number' || typeof c.exp !== 'number' || !Number.isFinite(c.iat) || !Number.isFinite(c.exp)) {
    throw new SignatureError('missing iat/exp');
  }
  const nowSec = Math.floor(opts.now() / 1000);
  if (c.iat > nowSec + RUN_REQUEST_CLOCK_SKEW_SECONDS) throw new SignatureError('issued in the future');
  if (c.exp <= nowSec - RUN_REQUEST_CLOCK_SKEW_SECONDS) throw new SignatureError('expired');
  if (c.exp <= c.iat || c.exp - c.iat > RUN_REQUEST_MAX_LIFETIME_SECONDS) throw new SignatureError('lifetime out of range');
  if (!(RUNNER_ACTIONS as readonly unknown[]).includes(c.action)) throw new SignatureError('unknown action');
  if (!isNonEmptyString(c.requestedBy)) throw new SignatureError('missing requestedBy');

  const action = c.action as RunnerAction;
  if (!opts.runnerId) throw new SignatureError('runner has no RUNNER_ID');
  if (c.aud !== opts.runnerId) throw new SignatureError('wrong aud');

  if (action !== 'ping' && !isNonEmptyString(c.pipelineId)) throw new SignatureError('missing pipelineId');
  if ((action === 'stop' || action === 'status') && !isNonEmptyString(c.executionId)) throw new SignatureError('missing executionId');
  let hint: RunClaims['hint'];
  if (c.hint !== undefined && c.hint !== null) {
    const raw = c.hint as Record<string, unknown>;
    if (typeof raw !== 'object' || !isNonEmptyString(raw.region) || !isNonEmptyString(raw.pipelineName)) {
      throw new SignatureError('malformed hint');
    }
    hint = { region: raw.region, pipelineName: raw.pipelineName };
  }

  // The deploy actions: each carries exactly its own fields, every one checked
  // here — before any AWS call and before anything reaches a CodeBuild override.
  const takesBlock = action === 'deploy' || action === 'undeploy';
  const takesBuild = action === 'deploy_status' || action === 'deploy_cancel';
  if (!takesBlock && c.deploy !== undefined) throw new SignatureError('unexpected deploy claim');
  if (!takesBuild && c.deployRequestId !== undefined) throw new SignatureError('unexpected deployRequestId');
  if (!takesBuild && c.buildId !== undefined) throw new SignatureError('unexpected buildId');
  const deploy = takesBlock ? parseDeployClaim(c.deploy, action) : undefined;
  if (takesBuild) {
    if (!isNonEmptyString(c.deployRequestId) || c.deployRequestId.length > 128) throw new SignatureError('missing deployRequestId');
    if (typeof c.buildId !== 'string' || !BUILD_ID_PATTERN.test(c.buildId)) throw new SignatureError('malformed buildId');
  }

  return {
    iss: c.iss,
    aud: c.aud,
    jti: c.jti,
    iat: c.iat,
    exp: c.exp,
    action,
    ...(isNonEmptyString(c.pipelineId) ? { pipelineId: c.pipelineId } : {}),
    ...(hint ? { hint } : {}),
    ...(isNonEmptyString(c.executionId) ? { executionId: c.executionId } : {}),
    ...(deploy ? { deploy } : {}),
    ...(takesBuild ? { deployRequestId: c.deployRequestId as string, buildId: c.buildId as string } : {}),
    requestedBy: c.requestedBy,
  };
}

/** A CodePipeline name (what the runner's prefix allowlist is matched against). */
export const PIPELINE_NAME_PATTERN = /^[A-Za-z0-9.@_-]{1,100}$/;
/** A CloudFormation stack name. */
export const STACK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
/** A managed toolchain release version (semver-like; it rides into a CodeBuild env override). */
export const TOOLCHAIN_RELEASE_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
/** A CodeBuild build id: `<project>:<uuid>` (no account id, no ARN). */
export const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,254}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The `deploy` claim block of a deploy / undeploy, every field checked; the mode must be the action. */
function parseDeployClaim(raw: unknown, action: 'deploy' | 'undeploy'): RunDeployClaim {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SignatureError('missing deploy claim');
  const d = raw as Record<string, unknown>;
  if (typeof d.grant !== 'string' || !DEPLOY_GRANT_PATTERN.test(d.grant)) throw new SignatureError('malformed deploy grant');
  if (typeof d.protocol !== 'number' || !Number.isInteger(d.protocol) || d.protocol < 1) throw new SignatureError('malformed deploy protocol');
  if (!(DEPLOY_JOB_MODES as readonly unknown[]).includes(d.mode) || d.mode !== action) throw new SignatureError('deploy mode is not the action');
  if (typeof d.region !== 'string' || !AWS_REGION_PATTERN.test(d.region)) throw new SignatureError('malformed deploy region');
  if (typeof d.pipelineName !== 'string' || !PIPELINE_NAME_PATTERN.test(d.pipelineName)) throw new SignatureError('malformed deploy pipelineName');
  if (typeof d.stackName !== 'string' || !STACK_NAME_PATTERN.test(d.stackName)) throw new SignatureError('malformed deploy stackName');
  const image = d.image as Record<string, unknown> | undefined;
  if (!image || typeof image !== 'object' || Array.isArray(image)) throw new SignatureError('missing deploy image');
  if (image.repository !== DEPLOY_JOB_IMAGE_REPOSITORY) throw new SignatureError('deploy image repository is not the managed cdk-synth');
  if (typeof image.digest !== 'string' || !DEPLOY_IMAGE_DIGEST_PATTERN.test(image.digest)) throw new SignatureError('malformed deploy image digest');
  if (typeof d.toolchainRelease !== 'string' || !TOOLCHAIN_RELEASE_PATTERN.test(d.toolchainRelease)) throw new SignatureError('malformed deploy toolchainRelease');
  return {
    grant: d.grant,
    protocol: d.protocol,
    mode: d.mode as DeployJobMode,
    region: d.region,
    pipelineName: d.pipelineName,
    stackName: d.stackName,
    image: { repository: DEPLOY_JOB_IMAGE_REPOSITORY, digest: image.digest },
    toolchainRelease: d.toolchainRelease,
  };
}

/** A remembered request: its final result once known. */
interface Seen<R> { firstSeenAt: number; result?: R }

/**
 * The in-memory `jti` replay guard. A repeat of a request whose FINAL result is
 * known gets that result back (delivery is at least once, so a retry after a
 * lost response must not act twice); a repeat while the first is still in
 * flight is a DUPLICATE. Transient outcomes are {@link forget}-ed so the
 * platform's retry is processed afresh.
 *
 * Best effort only: the cache lives in ONE warm container, and the function
 * runs up to two (reserved concurrency 2) and is recycled at will, so a
 * redelivery can land where the jti was never seen. Correctness does not rest
 * on it: a start passes the jti as CodePipeline's `clientRequestToken` (the
 * real idempotency guard: the same request starts one execution), and a stop of
 * an execution already stopping/stopped answers `stopped`.
 */
export class ReplayCache<R> {
  private seen = new Map<string, Seen<R>>();

  constructor(private readonly now: () => number) {}

  /** `undefined` for a new jti (now recorded as in flight); else what is known about it. */
  claim(jti: string): Seen<R> | undefined {
    this.prune();
    const prior = this.seen.get(jti);
    if (prior) return prior;
    this.seen.set(jti, { firstSeenAt: this.now() });
    return undefined;
  }

  complete(jti: string, result: R): void {
    const entry = this.seen.get(jti);
    if (entry) entry.result = result;
  }

  forget(jti: string): void {
    this.seen.delete(jti);
  }

  private prune(): void {
    const cutoff = this.now() - REPLAY_WINDOW_MS;
    for (const [jti, entry] of this.seen) if (entry.firstSeenAt < cutoff) this.seen.delete(jti);
  }
}
