/**
 * @jest-environment node
 */
// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The submission proof-of-work solver (plan §4.2, E3) must find exactly what
 * the server accepts: a decimal nonce with SHA-256("<challenge>:<nonce>")
 * starting with ≥ difficulty zero bits, searched from 0 so a challenge always
 * yields the same nonce. Checked three ways:
 *  - known vectors (computed independently with node:crypto);
 *  - the SHIPPED worker file (`public/workers/proof-of-work.js`) run as-is;
 *  - a round trip through api-core's own `createProofOfWorkChallenge` /
 *    `verifyProofOfWork`, the code the plugin service runs.
 */
import { describe, it, expect } from '@jest/globals';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkProofOfWork, expectedAttempts, leadingZeroBits, powProgress, solveProofOfWork,
} from '../src/lib/plugin-submissions/proof-of-work';

const subtle = webcrypto.subtle as unknown as SubtleCrypto;

/** Independent reference: node:crypto, not crypto.subtle. */
function nodeZeroBits(challenge: string, nonce: string): number {
  const hash = createHash('sha256').update(`${challenge}:${nonce}`).digest();
  return leadingZeroBits(new Uint8Array(hash));
}

// Vectors: the SMALLEST solving nonce, found with node:crypto counting from 0.
const VECTORS: Array<{ challenge: string; difficulty: number; nonce: string }> = [
  { challenge: 'abc', difficulty: 8, nonce: '181' },
  { challenge: 'eyJub25jZSI6InRlc3QiLCJkaWZmaWN1bHR5IjoxMiwiZXhwIjoxfQ.c2lnbmF0dXJl', difficulty: 12, nonce: '4139' },
];

describe('leadingZeroBits', () => {
  it('counts zero bits across byte boundaries', () => {
    expect(leadingZeroBits(new Uint8Array([0xff]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x10]))).toBe(11);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x00]))).toBe(24);
    expect(leadingZeroBits(new Uint8Array([]))).toBe(0);
  });
});

describe('solveProofOfWork (main-thread fallback)', () => {
  it.each(VECTORS)('finds nonce $nonce for difficulty $difficulty', async ({ challenge, difficulty, nonce }) => {
    const progress: number[] = [];
    const result = await solveProofOfWork(challenge, difficulty, { subtle, batchSize: 64, onProgress: (n) => progress.push(n) });
    expect(result.nonce).toBe(nonce);
    expect(result.attempts).toBe(Number(nonce) + 1);
    expect(nodeZeroBits(challenge, result.nonce)).toBeGreaterThanOrEqual(difficulty);
    // Every smaller nonce fails — the search really is in order from 0.
    for (let i = 0; i < Number(nonce); i++) expect(nodeZeroBits(challenge, String(i))).toBeLessThan(difficulty);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('gives the same nonce whatever the batch size', async () => {
    const { challenge, difficulty, nonce } = VECTORS[0];
    for (const batchSize of [1, 7, 256, 5000]) {
      expect((await solveProofOfWork(challenge, difficulty, { subtle, batchSize })).nonce).toBe(nonce);
    }
  });

  it('difficulty 0 is solved by nonce 0', async () => {
    expect((await solveProofOfWork('x', 0, { subtle })).nonce).toBe('0');
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(solveProofOfWork('abc', 30, { subtle, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('checkProofOfWork accepts the answer and refuses its neighbour', async () => {
    const { challenge, difficulty, nonce } = VECTORS[1];
    expect(await checkProofOfWork(challenge, nonce, difficulty, subtle)).toBe(true);
    expect(await checkProofOfWork(challenge, String(Number(nonce) - 1), difficulty, subtle)).toBe(false);
  });

  it('progress tracks expected work and never claims to be done', () => {
    expect(expectedAttempts(20)).toBe(1_048_576);
    expect(powProgress(524_288, 20)).toBeCloseTo(0.5);
    expect(powProgress(10_000_000, 20)).toBe(0.99);
  });
});

/** Load the shipped worker script into a fake worker scope. */
function loadWorker() {
  const source = readFileSync(join(__dirname, '..', 'public', 'workers', 'proof-of-work.js'), 'utf8');
  const posted: Array<Record<string, unknown>> = [];
  const scope: Record<string, unknown> = {
    crypto: webcrypto,
    postMessage: (m: Record<string, unknown>) => posted.push(m),
  };
  new Function('self', source)(scope);
  const run = (data: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
    const start = posted.length;
    (scope.onmessage as (e: { data: unknown }) => void)({ data });
    const poll = () => {
      const done = posted.slice(start).find((m) => m.type === 'done' || m.type === 'error');
      if (done) resolve(done); else setTimeout(poll, 5);
    };
    poll();
  });
  return { scope, posted, run };
}

describe('the shipped Web Worker (public/workers/proof-of-work.js)', () => {
  it.each(VECTORS)('answers $nonce for difficulty $difficulty and reports progress', async ({ challenge, difficulty, nonce }) => {
    const { posted, run } = loadWorker();
    const done = await run({ challenge, difficulty, batchSize: 32 });
    expect(done).toEqual({ type: 'done', nonce, attempts: Number(nonce) + 1 });
    expect(posted.some((m) => m.type === 'progress')).toBe(true);
  });

  it('uses the same leadingZeroBits as the TypeScript solver', () => {
    const { scope } = loadWorker();
    const lzb = (scope.__pbProofOfWork as { leadingZeroBits: (b: Uint8Array) => number }).leadingZeroBits;
    for (const bytes of [[0xff], [0x01], [0x00, 0x10], [0x00, 0x00, 0x07], []]) {
      expect(lzb(new Uint8Array(bytes))).toBe(leadingZeroBits(new Uint8Array(bytes)));
    }
  });

  it('reports an error when crypto.subtle is missing', async () => {
    const source = readFileSync(join(__dirname, '..', 'public', 'workers', 'proof-of-work.js'), 'utf8');
    const posted: Array<Record<string, unknown>> = [];
    const scope: Record<string, unknown> = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
    new Function('self', source)(scope);
    (scope.onmessage as (e: { data: unknown }) => void)({ data: { challenge: 'x', difficulty: 4 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(posted).toEqual([{ type: 'error', message: 'crypto.subtle is unavailable' }]);
  });
});

describe('round trip with the server-side helpers (api-core utils/proof-of-work)', () => {
  // Loaded by path: it is plain TypeScript over node:crypto, the exact code the plugin service verifies with.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const serverPow = require(join(__dirname, '..', '..', 'packages', 'api-core', 'src', 'utils', 'proof-of-work')) as {
    createProofOfWorkChallenge: (secret: string, opts?: { difficulty?: number }) => { challenge: string; difficulty: number };
    verifyProofOfWork: (s: { challenge: string; nonce: string }, secret: string) => { ok: boolean; reason?: string };
    solveProofOfWork: (challenge: string, difficulty: number) => string;
  };

  it('a challenge the server issues, solved by the browser solver, verifies on the server', async () => {
    const secret = 'test-secret';
    const { challenge, difficulty } = serverPow.createProofOfWorkChallenge(secret, { difficulty: 10 });
    const { nonce } = await solveProofOfWork(challenge, difficulty, { subtle });
    expect(serverPow.verifyProofOfWork({ challenge, nonce }, secret)).toMatchObject({ ok: true });
    // Same search order as the server's own solver, so the same answer.
    expect(nonce).toBe(serverPow.solveProofOfWork(challenge, difficulty));
  });

  it('the shipped worker agrees with the server too', async () => {
    const secret = 'test-secret';
    const { challenge, difficulty } = serverPow.createProofOfWorkChallenge(secret, { difficulty: 10 });
    const done = await loadWorker().run({ challenge, difficulty });
    expect(serverPow.verifyProofOfWork({ challenge, nonce: String(done.nonce) }, secret)).toMatchObject({ ok: true });
  });
});
