// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';

import { createEnvRedisClient } from './env-redis.js';
import { serviceIdentity } from './service-keys.js';
import { AI_DRAFT_ID_PATTERN, AI_DRAFT_ID_TTL_MS, type AiDraftFeature } from '../constants/ai-draft.js';
import { createLogger } from '../utils/logger.js';
import { errorMessage } from '../utils/response.js';

const logger = createLogger('ai-draft-store');

/** Who a draft was produced for, and by which feature. */
export interface AiDraftRef {
  orgId: string;
  userId: string;
  feature: AiDraftFeature;
}

/**
 * Result of {@link AiDraftStore.redeem}:
 *  - `ok`          — the id was live, issued to this org + user for this feature, and is now spent;
 *  - `invalid`     — unknown, expired, forged, or issued to another org / user / feature;
 *  - `used`        — the id was already redeemed once;
 *  - `unavailable` — the backend could not answer (fail-closed: nothing is counted).
 */
export type AiDraftRedeemResult = 'ok' | 'invalid' | 'used' | 'unavailable';

/**
 * Short-lived, single-use draft ids for AI-generated drafts.
 *
 * Every generator that hands a user a draft (pipeline / plugin generate, the
 * Ask agent's proposals) issues one id, bound to the org, the user and the
 * producing feature. `POST /ask-agent/draft-outcome` redeems it ONCE, so an
 * outcome can only ever be reported for a draft the server actually produced
 * for that caller — a member can no longer swing the org's acceptance rate by
 * posting outcomes in a loop.
 *
 * The id is 24 random bytes (unguessable), and the record is what authorizes
 * it: the key binds org + user, so another user's (or a forged) id simply does
 * not resolve. A redeemed id is kept, marked spent, until it expires, so a
 * reuse is told apart (409) from an unknown id (400).
 *
 * The Redis backend is shared by every service (`REDIS_URL` / `REDIS_SENTINELS`),
 * which is what lets ask-agent redeem an id the pipeline or plugin service
 * issued. Without Redis the in-memory backend is process-local: only ask-agent
 * (the redeemer) issues ids on it — its own agent drafts. The pipeline and
 * plugin services then serve their drafts WITHOUT an id ({@link issueAiDraftId}),
 * so the dashboard never reports an outcome nobody could verify.
 */
export interface AiDraftStore {
  /** True when ids issued here are visible to every service (Redis); false for the process-local memory backend. */
  readonly crossService: boolean;
  /** Issue a draft id for `ref`, or null when the backend could not record it. */
  issue(ref: AiDraftRef): Promise<string | null>;
  /** Redeem `draftId` for `ref`, exactly once. */
  redeem(draftId: string, ref: AiDraftRef): Promise<AiDraftRedeemResult>;
  /** Release timers. */
  stop(): void;
}

/** Store options. */
export interface AiDraftStoreConfig {
  /** Draft id lifetime (default {@link AI_DRAFT_ID_TTL_MS}). */
  ttlMs?: number;
}

function newDraftId(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** The record key: org and user are encoded so neither can spill into the other. */
function recordKey(draftId: string, ref: Pick<AiDraftRef, 'orgId' | 'userId'>): string {
  return `ai-draft:${encodeURIComponent(ref.orgId.toLowerCase())}:${encodeURIComponent(ref.userId)}:${draftId}`;
}

/** A redeemable ref: a well-formed id and a known org + user. */
function redeemable(draftId: string, ref: AiDraftRef): boolean {
  return typeof draftId === 'string' && AI_DRAFT_ID_PATTERN.test(draftId) && !!ref.orgId && !!ref.userId;
}

/** In-memory backend — single-process fallback when Redis isn't configured. */
export function createMemoryAiDraftStore(config: AiDraftStoreConfig = {}): AiDraftStore {
  const ttlMs = config.ttlMs ?? AI_DRAFT_ID_TTL_MS;
  const records = new Map<string, { feature: AiDraftFeature; spent: boolean; expiresAt: number }>();
  const sweep = (): void => {
    const now = Date.now();
    for (const [k, r] of records) if (now >= r.expiresAt) records.delete(k);
  };
  const timer = setInterval(sweep, Math.max(1_000, Math.min(ttlMs, 60_000)));
  timer.unref();

  return {
    crossService: false,
    async issue(ref) {
      if (!ref.orgId || !ref.userId) return null;
      const id = newDraftId();
      records.set(recordKey(id, ref), { feature: ref.feature, spent: false, expiresAt: Date.now() + ttlMs });
      return id;
    },
    async redeem(draftId, ref) {
      if (!redeemable(draftId, ref)) return 'invalid';
      const key = recordKey(draftId, ref);
      const r = records.get(key);
      if (!r || Date.now() >= r.expiresAt) {
        records.delete(key);
        return 'invalid';
      }
      if (r.feature !== ref.feature) return 'invalid';
      if (r.spent) return 'used';
      r.spent = true;
      return 'ok';
    },
    stop() { clearInterval(timer); },
  };
}

/** Minimal ioredis surface the Redis backend needs (`KEEPTTL` requires Redis ≥ 6.0). */
export interface AiDraftRedis {
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Atomic single-use redeem. The stored value is the producing feature, or
 * `<feature>:spent` once redeemed (kept until the id's own expiry, so a reuse
 * answers `used`). A feature mismatch spends nothing.
 *
 * KEYS: record key. ARGV: feature.
 */
const REDEEM_DRAFT_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if not v then return 'invalid' end
if v == ARGV[1] .. ':spent' then return 'used' end
if v ~= ARGV[1] then return 'invalid' end
redis.call('SET', KEYS[1], ARGV[1] .. ':spent', 'KEEPTTL')
return 'ok'`;

/**
 * Redis backend — multi-replica and cross-service safe. Fail-closed on redeem
 * (`unavailable`: no outcome is counted on an unverified id); an issue failure
 * returns null, so the draft is served without an id and its outcome is simply
 * not recorded.
 */
export function createRedisAiDraftStore(redis: AiDraftRedis, config: AiDraftStoreConfig = {}): AiDraftStore {
  const ttlMs = Math.max(1, Math.ceil(config.ttlMs ?? AI_DRAFT_ID_TTL_MS));
  return {
    crossService: true,
    async issue(ref) {
      if (!ref.orgId || !ref.userId) return null;
      try {
        const id = newDraftId();
        await redis.set(recordKey(id, ref), ref.feature, 'PX', ttlMs, 'NX');
        return id;
      } catch (err) {
        logger.warn('AI draft id issue failed', { error: errorMessage(err) });
        return null;
      }
    },
    async redeem(draftId, ref) {
      if (!redeemable(draftId, ref)) return 'invalid';
      try {
        const out = await redis.eval(REDEEM_DRAFT_SCRIPT, 1, recordKey(draftId, ref), ref.feature);
        return out === 'ok' || out === 'used' ? out : 'invalid';
      } catch (err) {
        logger.warn('AI draft id redeem failed (fail-closed)', { error: errorMessage(err) });
        return 'unavailable';
      }
    },
    stop() { /* keys expire on their own TTL */ },
  };
}

/**
 * Build an {@link AiDraftStore} from the standard Redis env: the Redis backend
 * when configured, otherwise the in-memory single-process backend.
 */
export function createEnvAiDraftStore(config: AiDraftStoreConfig = {}): AiDraftStore {
  const redis = createEnvRedisClient<AiDraftRedis>('ai-draft');
  if (redis) return createRedisAiDraftStore(redis, config);
  logger.info('AI draft store: in-memory backend (single-process fallback)');
  return createMemoryAiDraftStore(config);
}

let shared: AiDraftStore | undefined;

/** The process-wide draft store (built from the env on first use). */
export function getAiDraftStore(): AiDraftStore {
  shared ??= createEnvAiDraftStore();
  return shared;
}

/** Replace (or, with no argument, reset) the process-wide store. Tests only. */
export function _setAiDraftStoreForTests(store?: AiDraftStore): void {
  shared?.stop();
  shared = store;
}

/** The one service that redeems draft ids (`POST /ask-agent/draft-outcome`). */
const AI_DRAFT_REDEEMER = 'ask-agent';

/**
 * Issue a draft id for a draft about to be returned to the user, on the
 * process-wide store. Never throws: with no id the draft is still served, its
 * outcome just can't be recorded. Returns undefined for a caller with no user
 * (a service principal has nobody to report an outcome), and on a process-local
 * store when this service is not the redeemer: ask-agent could never resolve
 * that id, so issuing one would only make the dashboard report an outcome that
 * is refused.
 */
export async function issueAiDraftId(ref: AiDraftRef): Promise<string | undefined> {
  try {
    const store = getAiDraftStore();
    if (!store.crossService && serviceIdentity() !== AI_DRAFT_REDEEMER) return undefined;
    return (await store.issue(ref)) ?? undefined;
  } catch (err) {
    logger.warn('AI draft id issue failed', { error: errorMessage(err) });
    return undefined;
  }
}
