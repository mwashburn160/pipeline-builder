// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Self-hosted hashcash proof-of-work for the anonymous plugin submission API
 * (docs/plans/plugin-ecosystem.md §4.2, D1): no third-party captcha, so it
 * works air-gapped.
 *
 * A CHALLENGE is `base64url(JSON{ nonce, difficulty, exp }) + '.' +
 * base64url(HMAC-SHA256(body, secret))` — stateless, so any replica can verify
 * one another replica issued. A SOLUTION is a decimal-string `nonce` such that
 * `sha256("<challenge>:<nonce>")` starts with at least `difficulty` zero BITS.
 * Single use is the caller's job (a Redis `SET NX` on {@link challengeKey}
 * with the remaining lifetime as TTL): nothing here remembers anything.
 *
 * Pure and dependency-free apart from node:crypto, so the frontend can mirror
 * the algorithm exactly (its solver runs in a Web Worker with crypto.subtle)
 * and the CLI and tests can solve with {@link solveProofOfWork}.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** Default leading-zero-bit difficulty (≈1M hashes; a second or two in a browser). */
export const POW_DEFAULT_DIFFICULTY = 20;
/** Hard ceiling on a difficulty an operator can configure. */
export const POW_MAX_DIFFICULTY = 32;
/** How long a challenge stays solvable. */
export const POW_CHALLENGE_TTL_MS = 10 * 60_000;
/** A nonce is a decimal string of at most this many digits. */
const NONCE_MAX_DIGITS = 20;
/** A challenge string is never longer than this (bounds hashing work on garbage input). */
const CHALLENGE_MAX_LENGTH = 512;

/** What the challenge route returns. */
export interface ProofOfWorkChallenge {
  challenge: string;
  difficulty: number;
  expiresAt: string;
}

/** The signed body of a challenge. */
export interface ProofOfWorkChallengeBody {
  nonce: string;
  difficulty: number;
  /** Expiry, epoch ms. */
  exp: number;
}

/** A client's answer. */
export interface ProofOfWorkSolution {
  challenge: string;
  nonce: string;
}

export type ProofOfWorkRefusal = 'malformed' | 'bad_signature' | 'expired' | 'too_easy' | 'insufficient_work';

export type ProofOfWorkVerdict =
  | { ok: true; key: string; expiresAt: number; difficulty: number }
  | { ok: false; reason: ProofOfWorkRefusal };

const b64url = (buf: Buffer): string => buf.toString('base64url');

function sign(body: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest());
}

/** Number of leading zero BITS in `bytes`. */
export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    // Math.clz32 counts over 32 bits; a byte occupies the low 8.
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** The hash a solution is judged on: `sha256("<challenge>:<nonce>")`. */
export function proofOfWorkHash(challenge: string, nonce: string): Buffer {
  return createHash('sha256').update(`${challenge}:${nonce}`).digest();
}

/** The single-use key for a challenge (hex sha256 of the challenge string). */
export function challengeKey(challenge: string): string {
  return createHash('sha256').update(challenge).digest('hex');
}

/** Clamp a configured difficulty into [1, {@link POW_MAX_DIFFICULTY}]. */
export function clampDifficulty(difficulty: number): number {
  if (!Number.isFinite(difficulty)) return POW_DEFAULT_DIFFICULTY;
  return Math.min(POW_MAX_DIFFICULTY, Math.max(1, Math.floor(difficulty)));
}

/** Issue a fresh signed challenge. */
export function createProofOfWorkChallenge(
  secret: string,
  opts: { difficulty?: number; ttlMs?: number; now?: number } = {},
): ProofOfWorkChallenge {
  if (!secret) throw new Error('A proof-of-work secret is required');
  const now = opts.now ?? Date.now();
  const body: ProofOfWorkChallengeBody = {
    nonce: b64url(randomBytes(16)),
    difficulty: clampDifficulty(opts.difficulty ?? POW_DEFAULT_DIFFICULTY),
    exp: now + (opts.ttlMs ?? POW_CHALLENGE_TTL_MS),
  };
  const encoded = b64url(Buffer.from(JSON.stringify(body), 'utf8'));
  return { challenge: `${encoded}.${sign(encoded, secret)}`, difficulty: body.difficulty, expiresAt: new Date(body.exp).toISOString() };
}

/**
 * Decode a challenge and check its signature. Null when it is malformed or
 * was not signed with `secret` (expiry is NOT checked here).
 */
export function parseProofOfWorkChallenge(challenge: string, secret: string): ProofOfWorkChallengeBody | null {
  if (typeof challenge !== 'string' || challenge.length === 0 || challenge.length > CHALLENGE_MAX_LENGTH) return null;
  const dot = challenge.indexOf('.');
  if (dot <= 0 || dot !== challenge.lastIndexOf('.')) return null;
  const encoded = challenge.slice(0, dot);
  const given = Buffer.from(challenge.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(encoded, secret), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof body.nonce !== 'string' || typeof body.difficulty !== 'number' || typeof body.exp !== 'number') return null;
    if (!Number.isInteger(body.difficulty) || body.difficulty < 1 || body.difficulty > POW_MAX_DIFFICULTY) return null;
    return { nonce: body.nonce, difficulty: body.difficulty, exp: body.exp };
  } catch {
    return null;
  }
}

/**
 * Verify a solution: a genuine, unexpired challenge (signed with `secret`),
 * at least `minDifficulty` hard, whose hash with `nonce` has enough leading
 * zero bits. Does NOT enforce single use — store {@link ProofOfWorkVerdict.key}.
 */
export function verifyProofOfWork(
  solution: Partial<ProofOfWorkSolution> | null | undefined,
  secret: string,
  opts: { now?: number; minDifficulty?: number } = {},
): ProofOfWorkVerdict {
  const challenge = solution?.challenge;
  const nonce = solution?.nonce;
  if (typeof challenge !== 'string' || typeof nonce !== 'string') return { ok: false, reason: 'malformed' };
  if (!/^\d+$/.test(nonce) || nonce.length > NONCE_MAX_DIGITS) return { ok: false, reason: 'malformed' };
  if (!secret) return { ok: false, reason: 'bad_signature' };
  const body = parseProofOfWorkChallenge(challenge, secret);
  if (!body) return { ok: false, reason: 'bad_signature' };
  if ((opts.now ?? Date.now()) > body.exp) return { ok: false, reason: 'expired' };
  if (opts.minDifficulty !== undefined && body.difficulty < clampDifficulty(opts.minDifficulty)) return { ok: false, reason: 'too_easy' };
  if (leadingZeroBits(proofOfWorkHash(challenge, nonce)) < body.difficulty) return { ok: false, reason: 'insufficient_work' };
  return { ok: true, key: challengeKey(challenge), expiresAt: body.exp, difficulty: body.difficulty };
}

/**
 * Find a nonce for `challenge` (tests, the CLI). Counts up from 0; throws
 * after `maxIterations` so a mistaken difficulty can't spin forever.
 */
export function solveProofOfWork(challenge: string, difficulty: number, opts: { maxIterations?: number } = {}): string {
  const max = opts.maxIterations ?? 2 ** 32;
  for (let i = 0; i < max; i++) {
    const nonce = String(i);
    if (leadingZeroBits(proofOfWorkHash(challenge, nonce)) >= difficulty) return nonce;
  }
  throw new Error(`No proof-of-work solution within ${max} iterations`);
}
