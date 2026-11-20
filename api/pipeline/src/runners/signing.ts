// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Run-request signing with PER-ORG Ed25519 keys.
 *
 * Each org's keys live encrypted in `pipeline_runner_signing_keys` (see
 * keys.ts); there is no deployment-wide key and nothing is read from the
 * environment. {@link createOrgSignerCache} is the per-replica cache behind
 * `deps.signerFor(orgId)`: it holds a signer (a `KeyObject`, never a PEM) per
 * runner-owning org, drops an entry at once on a pub/sub invalidation, and
 * re-checks the org set's `runner_key_version` every `RUNNER_KEY_CACHE_MS` as
 * the backstop for a missed message.
 */

import type { KeyObject } from 'node:crypto';
import { RUN_REQUEST_ISS, RUN_REQUEST_TTL_MS, RUN_REQUEST_TYP, RUNNER_KEY_CACHE_MS, type RunClaims, type RunnerAction } from '@pipeline-builder/api-core/pipeline-runners';
import { ed25519Jwk, signEdDsaJws, type Ed25519Jwk } from './jws.js';

/** The signed request's fixed protocol fields. */
export { RUN_REQUEST_ISS, RUN_REQUEST_TYP };

/** `status` is read-only: the runner reports an execution's state (GetPipelineExecution). */
export type SignedAction = RunnerAction;

/** What one signed run request asserts (iss/iat/exp are added by the signer). */
export interface RunRequestClaimsInput {
  runnerId: string;
  requestId: string;
  action: SignedAction;
  pipelineId?: string;
  hint?: { region: string; pipelineName: string };
  executionId?: string;
  requestedBy: string;
  /** The request's own expiry: the token never outlives it. */
  expiresAt?: Date;
}

export interface RunRequestSigner {
  /** The signing key's public JWK set (`{ keys }`) — current first. */
  jwks(): { keys: Ed25519Jwk[] };
  /** The kid the signer stamps on every token. */
  readonly kid: string;
  /** A compact JWS for one request. */
  sign(input: RunRequestClaimsInput): string;
}

/** Build a signer over explicit keys. */
export function createRunRequestSigner(current: KeyObject, previous: KeyObject | undefined, now: () => number = Date.now): RunRequestSigner {
  const currentJwk = ed25519Jwk(current);
  const keys = [currentJwk, ...(previous ? [ed25519Jwk(previous)] : [])].filter((k, i, all) => all.findIndex((o) => o.kid === k.kid) === i);
  return {
    kid: currentJwk.kid,
    jwks: () => ({ keys: keys.map((k) => ({ ...k })) }),
    sign(input) {
      const iat = Math.floor(now() / 1000);
      const cap = input.expiresAt ? Math.floor(input.expiresAt.getTime() / 1000) : Number.POSITIVE_INFINITY;
      const exp = Math.max(iat + 1, Math.min(iat + RUN_REQUEST_TTL_MS / 1000, cap));
      const claims: RunClaims = {
        iss: RUN_REQUEST_ISS,
        aud: input.runnerId,
        jti: input.requestId,
        iat,
        exp,
        action: input.action,
        ...(input.pipelineId ? { pipelineId: input.pipelineId } : {}),
        ...(input.hint ? { hint: input.hint } : {}),
        ...(input.executionId ? { executionId: input.executionId } : {}),
        requestedBy: input.requestedBy,
      };
      return signEdDsaJws({ typ: RUN_REQUEST_TYP, kid: currentJwk.kid }, claims, current);
    },
  };
}

// -- The per-org signer cache ------------------------------------------------------

/** One resolved signer and what its freshness depends on. */
export interface ResolvedSigner {
  signer: RunRequestSigner;
  /** The orgs whose key or key-mode rows decide this signer (the owner's chain, plus a transition's previous org). */
  versionOrgIds: string[];
  /** Their `runner_key_version` when it was resolved. */
  version: number;
}

export interface OrgSignerCacheOptions {
  /** Build the signer for a runner-owning org (throws RUNNER_KEY_MISSING / RUNNER_KEY_UNREADABLE). */
  resolve(orgId: string): Promise<ResolvedSigner>;
  /** The current version of an org set. */
  version(orgIds: readonly string[]): Promise<number>;
  now?: () => number;
  ttlMs?: number;
  /** Called once per dropped entry (`pipeline_runner_signing_key_invalidations_total{source}`). */
  onInvalidate?: (source: 'pubsub' | 'poll') => void;
}

export interface OrgSignerCache {
  signerFor(orgId: string): Promise<RunRequestSigner>;
  /** Drop the entries of these runner-owning orgs (a pub/sub message). */
  invalidate(orgIds: readonly string[], source?: 'pubsub' | 'poll'): void;
  /** Drop everything (a resubscribe: messages may have been missed). */
  clear(): void;
  /** Cached owner orgs (tests and diagnostics). */
  size(): number;
}

interface Entry extends ResolvedSigner { checkedAt: number }

/**
 * The per-replica signer cache. A hit younger than `ttlMs` is served as is; an
 * older one re-reads the version and is kept only if it is unchanged.
 * Concurrent first calls for one org share one resolution.
 */
export function createOrgSignerCache(opts: OrgSignerCacheOptions): OrgSignerCache {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? RUNNER_KEY_CACHE_MS;
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<RunRequestSigner>>();
  // Bumped on every invalidation, so a resolution that started before it is not cached.
  let generation = 0;

  const load = (key: string, orgId: string): Promise<RunRequestSigner> => {
    let p = inFlight.get(key);
    if (!p) {
      const gen = generation;
      p = opts.resolve(orgId).then((r) => {
        if (gen === generation) entries.set(key, { ...r, checkedAt: now() });
        return r.signer;
      }).finally(() => { inFlight.delete(key); });
      inFlight.set(key, p);
    }
    return p;
  };

  return {
    async signerFor(orgId) {
      const key = orgId.toLowerCase();
      const hit = entries.get(key);
      if (hit) {
        if (now() - hit.checkedAt < ttl) return hit.signer;
        const v = await opts.version(hit.versionOrgIds);
        if (v === hit.version && entries.get(key) === hit) {
          hit.checkedAt = now();
          return hit.signer;
        }
        if (entries.get(key) === hit) {
          entries.delete(key);
          opts.onInvalidate?.('poll');
        }
      }
      return load(key, orgId);
    },
    invalidate(orgIds, source = 'pubsub') {
      generation++;
      for (const o of orgIds) {
        if (entries.delete(o.toLowerCase())) opts.onInvalidate?.(source);
      }
    },
    clear() {
      generation++;
      entries.clear();
    },
    size: () => entries.size,
  };
}
