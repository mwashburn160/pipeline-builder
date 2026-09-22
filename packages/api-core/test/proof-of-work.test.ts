// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for utils/proof-of-work — the self-hosted hashcash the anonymous
 * plugin submission API requires.
 */

import { createHash } from 'crypto';
import { describe, it, expect } from '@jest/globals';
import {
  challengeKey, clampDifficulty, createProofOfWorkChallenge, leadingZeroBits, parseProofOfWorkChallenge,
  proofOfWorkHash, solveProofOfWork, verifyProofOfWork, POW_CHALLENGE_TTL_MS, POW_MAX_DIFFICULTY,
} from '../src/utils/proof-of-work.js';

const SECRET = 'pow-test-secret';

describe('leadingZeroBits', () => {
  it('counts zero bits across bytes', () => {
    expect(leadingZeroBits(new Uint8Array([0xff]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x40]))).toBe(1);
    expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x0f]))).toBe(12);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x00]))).toBe(24);
    expect(leadingZeroBits(new Uint8Array([]))).toBe(0);
  });
});

describe('createProofOfWorkChallenge / parseProofOfWorkChallenge', () => {
  it('round-trips a signed body', () => {
    const c = createProofOfWorkChallenge(SECRET, { difficulty: 12, now: 1_000 });
    expect(c.difficulty).toBe(12);
    expect(c.expiresAt).toBe(new Date(1_000 + POW_CHALLENGE_TTL_MS).toISOString());
    const body = parseProofOfWorkChallenge(c.challenge, SECRET);
    expect(body).toMatchObject({ difficulty: 12, exp: 1_000 + POW_CHALLENGE_TTL_MS });
    expect(typeof body!.nonce).toBe('string');
  });

  it('issues a different challenge every time', () => {
    expect(createProofOfWorkChallenge(SECRET).challenge).not.toBe(createProofOfWorkChallenge(SECRET).challenge);
  });

  it('refuses a challenge signed with another secret or tampered with', () => {
    const c = createProofOfWorkChallenge(SECRET, { difficulty: 8 });
    expect(parseProofOfWorkChallenge(c.challenge, 'other')).toBeNull();
    const [body, sig] = c.challenge.split('.');
    const easier = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), difficulty: 1 })).toString('base64url');
    expect(parseProofOfWorkChallenge(`${easier}.${sig}`, SECRET)).toBeNull();
    expect(parseProofOfWorkChallenge('garbage', SECRET)).toBeNull();
    expect(parseProofOfWorkChallenge('a.b.c', SECRET)).toBeNull();
    expect(parseProofOfWorkChallenge('x'.repeat(2000), SECRET)).toBeNull();
  });

  it('refuses to issue without a secret', () => {
    expect(() => createProofOfWorkChallenge('')).toThrow();
  });

  it('clamps the difficulty', () => {
    expect(clampDifficulty(0)).toBe(1);
    expect(clampDifficulty(99)).toBe(POW_MAX_DIFFICULTY);
    expect(clampDifficulty(Number.NaN)).toBe(20);
    expect(createProofOfWorkChallenge(SECRET, { difficulty: 400 }).difficulty).toBe(POW_MAX_DIFFICULTY);
  });
});

describe('verifyProofOfWork', () => {
  it('accepts a solved challenge and returns its single-use key', () => {
    const c = createProofOfWorkChallenge(SECRET, { difficulty: 10 });
    const nonce = solveProofOfWork(c.challenge, 10);
    expect(leadingZeroBits(proofOfWorkHash(c.challenge, nonce))).toBeGreaterThanOrEqual(10);
    const v = verifyProofOfWork({ challenge: c.challenge, nonce }, SECRET);
    expect(v).toMatchObject({ ok: true, difficulty: 10, key: challengeKey(c.challenge) });
    expect(challengeKey(c.challenge)).toBe(createHash('sha256').update(c.challenge).digest('hex'));
  });

  it('refuses a wrong nonce', () => {
    const c = createProofOfWorkChallenge(SECRET, { difficulty: 16 });
    const nonce = solveProofOfWork(c.challenge, 16);
    // Find a nonce that does NOT meet the difficulty.
    let bad = 0;
    while (leadingZeroBits(proofOfWorkHash(c.challenge, String(bad))) >= 16 || String(bad) === nonce) bad++;
    expect(verifyProofOfWork({ challenge: c.challenge, nonce: String(bad) }, SECRET)).toEqual({ ok: false, reason: 'insufficient_work' });
  });

  it('refuses an expired challenge', () => {
    const c = createProofOfWorkChallenge(SECRET, { difficulty: 4, now: 0, ttlMs: 1_000 });
    const nonce = solveProofOfWork(c.challenge, 4);
    expect(verifyProofOfWork({ challenge: c.challenge, nonce }, SECRET, { now: 500 }).ok).toBe(true);
    expect(verifyProofOfWork({ challenge: c.challenge, nonce }, SECRET, { now: 1_001 })).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a challenge easier than the configured minimum', () => {
    const c = createProofOfWorkChallenge(SECRET, { difficulty: 4 });
    const nonce = solveProofOfWork(c.challenge, 4);
    expect(verifyProofOfWork({ challenge: c.challenge, nonce }, SECRET, { minDifficulty: 8 })).toEqual({ ok: false, reason: 'too_easy' });
  });

  it('refuses malformed input and foreign signatures', () => {
    const c = createProofOfWorkChallenge(SECRET, { difficulty: 4 });
    const nonce = solveProofOfWork(c.challenge, 4);
    expect(verifyProofOfWork(null, SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyProofOfWork({ challenge: c.challenge }, SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyProofOfWork({ challenge: c.challenge, nonce: '-1' }, SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyProofOfWork({ challenge: c.challenge, nonce: '1e3' }, SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyProofOfWork({ challenge: c.challenge, nonce: '9'.repeat(21) }, SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyProofOfWork({ challenge: c.challenge, nonce }, 'another-secret')).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyProofOfWork({ challenge: c.challenge, nonce }, '')).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('gives up solving past maxIterations', () => {
    const c = createProofOfWorkChallenge(SECRET, { difficulty: 32 });
    expect(() => solveProofOfWork(c.challenge, 32, { maxIterations: 10 })).toThrow(/No proof-of-work solution/);
  });
});
