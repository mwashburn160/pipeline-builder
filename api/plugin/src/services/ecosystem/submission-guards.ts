// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What stands in front of every anonymous write: the submitter's email and
 * tokens (only ever stored hashed or encrypted), the single-use
 * proof-of-work, and the per-email / per-IP daily caps.
 */

import { createHash, createHmac } from 'crypto';

import {
  createLogger,
  createProofOfWorkChallenge,
  decryptSecret,
  encryptSecret,
  ErrorCode,
  errorMessage,
  isEncryptedBlob,
  SYSTEM_ORG_ID,
  verifyProofOfWork,
  type ProofOfWorkChallenge,
} from '@pipeline-builder/api-core';
import { type PluginSubmission } from '@pipeline-builder/pipeline-data';

import { EcosystemError } from './context.js';
import { submissionConfig } from './submission-config.js';
import { DAY_MS } from './util.js';

const logger = createLogger('ecosystem-submission-guards');

// -----------------------------------------------------------------------------
// Emails and tokens
// -----------------------------------------------------------------------------

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The canonical form of a submitter email, or null when it isn't one. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 320 && EMAIL_SHAPE.test(email) ? email : null;
}

/** HMAC of a normalized email (the only form rate limits and claim matching see). */
export function hashEmail(email: string, secret: string = submissionConfig().emailHashSecret): string {
  return createHmac('sha256', secret).update(`email:${email}`).digest('hex');
}

/** HMAC of the trusted client IP (the per-IP cap; the IP itself is never stored). */
export function hashClientIp(ip: string, secret: string = submissionConfig().emailHashSecret): string {
  return createHmac('sha256', secret).update(`ip:${ip}`).digest('hex');
}

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** The status token of a submission: derived from its id with the server secret. */
export function statusTokenFor(submissionId: string, secret: string = submissionConfig().emailHashSecret): string {
  return createHmac('sha256', secret).update(`status-token:v1:${submissionId}`).digest('base64url');
}

/** A token as it is stored (sha256 hex). */
export const tokenHash = (token: string) => sha256Hex(token);

/** Encrypt the submitter's email for the transactional notices (system-org key). */
export async function encryptEmail(email: string): Promise<string> {
  return JSON.stringify(await encryptSecret(email, SYSTEM_ORG_ID));
}

/** The submitter's email, or null when it was purged or can't be read. */
export async function submitterEmail(s: Pick<PluginSubmission, 'id' | 'emailEnc'>): Promise<string | null> {
  if (!s.emailEnc) return null;
  try {
    const blob: unknown = JSON.parse(s.emailEnc);
    return isEncryptedBlob(blob) ? await decryptSecret(blob, SYSTEM_ORG_ID) : null;
  } catch (err) {
    logger.warn('Submitter email unreadable', { submissionId: s.id, error: errorMessage(err) });
    return null;
  }
}

// -----------------------------------------------------------------------------
// Proof-of-work
// -----------------------------------------------------------------------------

/** Single-use bookkeeping for solved challenges. */
export interface PowReplayStore {
  /** True the FIRST time `key` is claimed within `ttlMs`; false on a replay. Throws when the store is down. */
  claim(key: string, ttlMs: number): Promise<boolean>;
}

const redisReplayStore: PowReplayStore = {
  async claim(key, ttlMs) {
    const { getHealthRedisConnection } = await import('../../queue/connections.js');
    const ok = await getHealthRedisConnection().set(`plugin-submission:pow:${key}`, '1', 'PX', Math.max(1_000, ttlMs), 'NX');
    return ok === 'OK';
  },
};

let replayStore: PowReplayStore = redisReplayStore;

/** Test hook: replace the replay store (pass nothing to restore Redis). */
export function setPowReplayStoreForTests(store?: PowReplayStore): void {
  replayStore = store ?? redisReplayStore;
}

// -----------------------------------------------------------------------------
// Daily caps: one atomic counter per key, checked BEFORE any parsing
// -----------------------------------------------------------------------------

/** Rolling-window counters for the per-email / per-IP caps. */
export interface DailyCapStore {
  /** Increment `key` and return the new count; the window (`ttlMs`) starts at the first hit. Throws when the store is down. */
  incr(key: string, ttlMs: number): Promise<number>;
}

const INCR_WITH_WINDOW = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

const redisDailyCapStore: DailyCapStore = {
  async incr(key, ttlMs) {
    const { getHealthRedisConnection } = await import('../../queue/connections.js');
    return Number(await getHealthRedisConnection().eval(INCR_WITH_WINDOW, 1, `plugin-submission:cap:${key}`, String(ttlMs)));
  },
};

let dailyCaps: DailyCapStore = redisDailyCapStore;

/** Test hook: replace the daily-cap store (pass nothing to restore Redis). */
export function setDailyCapStoreForTests(store?: DailyCapStore): void {
  dailyCaps = store ?? redisDailyCapStore;
}

/**
 * Count one attempt against each key (in order) and refuse with 429
 * `SUBMISSION_LIMIT` once any passes `max` in its 24 h window. Atomic per key
 * (one INCR), so concurrent requests can't all read "2 of 3" and pass. A store
 * outage FAILS CLOSED (503): without the counter there is no cap.
 */
export async function consumeDailyCaps(keys: string[], max: number, what: string): Promise<void> {
  for (const key of keys) {
    let n: number;
    try {
      n = await dailyCaps.incr(key, DAY_MS);
    } catch (err) {
      logger.warn('Submission cap store unavailable; refusing', { error: errorMessage(err) });
      throw new EcosystemError(ErrorCode.SERVICE_UNAVAILABLE, 'Submissions are temporarily unavailable; try again shortly.');
    }
    if (!Number.isFinite(n) || n > max) {
      throw new EcosystemError(ErrorCode.SUBMISSION_LIMIT, `At most ${max} ${what} a day; try again tomorrow.`);
    }
  }
}

/** GET /challenge — a fresh challenge at the configured difficulty. */
export function issueChallenge(): ProofOfWorkChallenge {
  const cfg = submissionConfig();
  return createProofOfWorkChallenge(cfg.powSecret, { difficulty: cfg.powDifficulty });
}

/**
 * Verify and CONSUME a proof-of-work answer: a JSON string (multipart field)
 * or an object `{ challenge, nonce }`. Refused: missing, malformed, forged,
 * expired, easier than configured, wrong, or already used. A replay store
 * outage fails closed (503).
 */
export async function consumeProofOfWork(raw: unknown): Promise<void> {
  let solution: unknown = raw;
  if (typeof raw === 'string') {
    try {
      solution = JSON.parse(raw);
    } catch {
      solution = null;
    }
  }
  if (!solution || typeof solution !== 'object') {
    throw new EcosystemError(ErrorCode.PROOF_OF_WORK_INVALID, 'A proof-of-work answer is required (GET /challenge, then solve it).');
  }
  const cfg = submissionConfig();
  const verdict = verifyProofOfWork(solution as { challenge?: string; nonce?: string }, cfg.powSecret, { minDifficulty: cfg.powDifficulty });
  if (!verdict.ok) {
    throw new EcosystemError(ErrorCode.PROOF_OF_WORK_INVALID, `The proof-of-work answer was refused (${verdict.reason}); request a new challenge.`, { reason: verdict.reason });
  }
  let first: boolean;
  try {
    first = await replayStore.claim(verdict.key, verdict.expiresAt - Date.now());
  } catch (err) {
    logger.warn('Proof-of-work replay store unavailable; refusing', { error: errorMessage(err) });
    throw new EcosystemError(ErrorCode.SERVICE_UNAVAILABLE, 'Submissions are temporarily unavailable; try again shortly.');
  }
  if (!first) throw new EcosystemError(ErrorCode.PROOF_OF_WORK_INVALID, 'That proof-of-work answer was already used; request a new challenge.', { reason: 'replayed' });
}

