// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The client half of the submission proof-of-work:
 * find a decimal `nonce` such that SHA-256(`${challenge}:${nonce}`) starts with
 * at least `difficulty` zero BITS. It mirrors api-core's
 * `utils/proof-of-work.ts` (`verifyProofOfWork`, `leadingZeroBits`), which is
 * what the server checks.
 *
 * The search runs in a Web Worker (`/workers/proof-of-work.js`, served from
 * `public/`), so the page stays responsive. The worker is a same-origin file
 * rather than a blob, because the CSP's `script-src 'self'` forbids blob
 * workers. When no worker can start, the same search runs on the main thread
 * in yielding batches ({@link solveProofOfWork}).
 *
 * Nonces are tried in order from 0, so a given challenge always yields the
 * same (smallest) nonce. The tests pin that against known vectors.
 */

import { abortError } from '@/lib/abort';

/** Where the worker is served (`frontend/public/workers/proof-of-work.js`). */
export const POW_WORKER_URL = '/workers/proof-of-work.js';

/** Hashes per batch: enough to keep `crypto.subtle` busy, small enough to report progress often. */
export const POW_BATCH_SIZE = 256;

/** The main-thread fallback works in slices of about one frame before yielding. */
const MAIN_THREAD_SLICE_MS = 16;

export interface PowResult {
  nonce: string;
  /** Hashes computed, including the winning one. */
  attempts: number;
}

export interface PowOptions {
  /** Called after every batch with the hashes computed so far. */
  onProgress?: (attempts: number) => void;
  signal?: AbortSignal;
  batchSize?: number;
  /** Injected in tests; defaults to `globalThis.crypto.subtle`. */
  subtle?: SubtleCrypto;
}

/** How many zero bits the hash starts with. */
export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/** The string that is hashed for one attempt. */
export function powInput(challenge: string, nonce: string | number): string {
  return `${challenge}:${nonce}`;
}

/** The average number of hashes a difficulty takes (2^difficulty). */
export function expectedAttempts(difficulty: number): number {
  return 2 ** Math.max(0, difficulty);
}

/** 0–1: how far through the EXPECTED work the search is (capped below 1; the real finish is random). */
export function powProgress(attempts: number, difficulty: number): number {
  return Math.min(0.99, attempts / expectedAttempts(difficulty));
}

function defaultSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('This browser cannot compute SHA-256 (crypto.subtle is unavailable; use HTTPS).');
  return subtle;
}

/** Does this nonce solve the challenge? (The same check the server makes.) */
export async function checkProofOfWork(
  challenge: string, nonce: string, difficulty: number, subtle: SubtleCrypto = defaultSubtle(),
): Promise<boolean> {
  const hash = await subtle.digest('SHA-256', new TextEncoder().encode(powInput(challenge, nonce)));
  return leadingZeroBits(new Uint8Array(hash)) >= difficulty;
}

/**
 * Search for the smallest solving nonce on the CURRENT thread. Yields to the
 * event loop between batches so the page can still paint and respond.
 */
export async function solveProofOfWork(challenge: string, difficulty: number, opts: PowOptions = {}): Promise<PowResult> {
  const subtle = opts.subtle ?? defaultSubtle();
  const batch = Math.max(1, opts.batchSize ?? POW_BATCH_SIZE);
  const encoder = new TextEncoder();
  let next = 0;
  let lastYield = Date.now();
  for (;;) {
    if (opts.signal?.aborted) throw abortError();
    const digests: Array<Promise<ArrayBuffer>> = [];
    for (let i = 0; i < batch; i++) {
      digests.push(subtle.digest('SHA-256', encoder.encode(powInput(challenge, next + i))));
    }
    const hashes = await Promise.all(digests);
    for (let i = 0; i < hashes.length; i++) {
      if (leadingZeroBits(new Uint8Array(hashes[i])) >= difficulty) {
        return { nonce: String(next + i), attempts: next + i + 1 };
      }
    }
    next += batch;
    opts.onProgress?.(next);
    // Give the page a frame now and then (a yield per batch would dominate the run time).
    if (Date.now() - lastYield >= MAIN_THREAD_SLICE_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      lastYield = Date.now();
    }
  }
}

type WorkerMessage =
  | { type: 'progress'; attempts: number }
  | { type: 'done'; nonce: string; attempts: number }
  | { type: 'error'; message: string };

/**
 * Solve in the Web Worker, falling back to the main thread when a worker
 * can't start (no `Worker`, or the script failed to load). Aborting the signal
 * terminates the worker.
 */
export function solveInWorker(challenge: string, difficulty: number, opts: PowOptions = {}): Promise<PowResult> {
  if (typeof Worker === 'undefined') return solveProofOfWork(challenge, difficulty, opts);
  if (opts.signal?.aborted) return Promise.reject(abortError());

  return new Promise<PowResult>((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(POW_WORKER_URL);
    } catch {
      solveProofOfWork(challenge, difficulty, opts).then(resolve, reject);
      return;
    }
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(abortError()));
    opts.signal?.addEventListener('abort', onAbort);

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data;
      if (msg.type === 'progress') opts.onProgress?.(msg.attempts);
      else if (msg.type === 'done') finish(() => resolve({ nonce: msg.nonce, attempts: msg.attempts }));
      else finish(() => reject(new Error(msg.message || 'Proof of work failed')));
    };
    // The script didn't load or crashed: do the work here instead.
    worker.onerror = (event) => {
      event.preventDefault?.();
      finish(() => { solveProofOfWork(challenge, difficulty, opts).then(resolve, reject); });
    };
    worker.postMessage({ challenge, difficulty, batchSize: opts.batchSize ?? POW_BATCH_SIZE });
  });
}
