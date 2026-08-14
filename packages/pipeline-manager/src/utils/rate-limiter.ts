// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Simple file-based rate limiter for auth operations.
 * Tracks failed attempts and enforces a cooldown period after too many failures.
 * State is persisted in a temp file so it survives across CLI invocations.
 *
 * State is keyed per (baseUrl, identifier) so a failed login for one account does
 * NOT lock out another account on a shared workstation / CI host. Calls without an
 * identifier fall back to a shared `_default` bucket (coarse anti-bruteforce).
 */

const STATE_FILE = path.join(os.tmpdir(), '.pipeline-manager-auth-state.json');
// Directory-as-mutex guarding the read-modify-write. `mkdir` is atomic on every
// platform, so concurrent CLI invocations serialize on it instead of racing (a
// lost increment would under-count toward lockout — see withLock).
const LOCK_DIR = `${STATE_FILE}.lock`;
const MAX_FAILURES = 5;
const COOLDOWN_MS = 60_000; // 1 minute
const PRUNE_MS = 60 * 60_000; // drop buckets idle for >1h to bound file growth
const LOCK_STALE_MS = 5_000; // reclaim a lock left by a crashed process
const LOCK_WAIT_MS = 1_000; // give up waiting after this (best-effort: proceed unlocked)
const LOCK_RETRY_MS = 15; // spin interval while the lock is held

interface AuthState {
  failures: number;
  lastFailure: number;
  lockedUntil: number;
}

type StateMap = Record<string, AuthState>;

const EMPTY: AuthState = { failures: 0, lastFailure: 0, lockedUntil: 0 };

/** Stable, non-reversible bucket key for a (baseUrl, identifier) pair. */
function keyFor(identifier?: string, baseUrl?: string): string {
  if (!identifier) return '_default';
  return crypto.createHash('sha256').update(`${baseUrl ?? ''}\n${identifier}`).digest('hex').slice(0, 16);
}

function readMap(): StateMap {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as StateMap;
    }
  } catch { /* ignore corrupt state */ }
  return {};
}

function writeMap(map: StateMap): void {
  const now = Date.now();
  // Prune idle buckets so the file doesn't grow unbounded across many identifiers.
  for (const [k, s] of Object.entries(map)) {
    if (s.lockedUntil <= now && now - s.lastFailure > PRUNE_MS) delete map[k];
  }
  try {
    // Write to a per-process temp file then rename: rename is atomic on the same
    // filesystem, so a concurrent reader never observes a torn/half-written file.
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch { /* best-effort */ }
}

/** Block the current thread for `ms` without a busy-wait (CLI-only, short waits). */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding a cross-process advisory lock so the read-modify-write in
 * recordAuthFailure/Success can't lose an update to a concurrent CLI invocation
 * (the TOCTOU that let parallel runs under-count toward lockout). Best-effort: if
 * the lock can't be acquired within LOCK_WAIT_MS we proceed anyway rather than
 * block the user — server-side rate limiting remains the real enforcement.
 */
function withLock<T>(fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(LOCK_DIR);
      held = true;
      break;
    } catch {
      // Held elsewhere — reclaim it if it's stale (owner crashed without cleanup),
      // otherwise wait a beat and retry.
      try {
        if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(LOCK_DIR);
          continue;
        }
      } catch { /* lock vanished between calls — just retry */ }
      sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try { fs.rmdirSync(LOCK_DIR); } catch { /* already gone */ }
    }
  }
}

/**
 * Check if auth attempts for this identifier are currently rate-limited.
 * @returns null if allowed, or a message string if blocked.
 */
export function checkAuthRateLimit(identifier?: string, baseUrl?: string): string | null {
  const key = keyFor(identifier, baseUrl);
  const map = readMap();
  const state = map[key] ?? EMPTY;
  const now = Date.now();

  if (state.lockedUntil > now) {
    const waitSec = Math.ceil((state.lockedUntil - now) / 1000);
    return `Too many failed login attempts. Try again in ${waitSec}s.`;
  }

  // Reset this bucket once the cooldown window has passed. Re-read under the lock
  // so we don't clobber a concurrent recordAuthFailure for another bucket.
  if (state.lastFailure !== 0 && now - state.lastFailure > COOLDOWN_MS) {
    withLock(() => {
      const m = readMap();
      const s = m[key];
      if (s && s.lastFailure !== 0 && Date.now() - s.lastFailure > COOLDOWN_MS) {
        delete m[key];
        writeMap(m);
      }
    });
  }

  return null;
}

/**
 * Record a successful auth for this identifier — clears its failure counter.
 */
export function recordAuthSuccess(identifier?: string, baseUrl?: string): void {
  withLock(() => {
    const map = readMap();
    delete map[keyFor(identifier, baseUrl)];
    writeMap(map);
  });
}

/**
 * Record a failed auth attempt for this identifier. After MAX_FAILURES, locks out
 * that identifier for COOLDOWN_MS.
 */
export function recordAuthFailure(identifier?: string, baseUrl?: string): void {
  const key = keyFor(identifier, baseUrl);
  // Read-modify-write under the lock: a concurrent CLI invocation must not read the
  // same pre-increment count and overwrite this one (which would under-count).
  withLock(() => {
    const map = readMap();
    const now = Date.now();
    const state = { ...(map[key] ?? EMPTY) };
    state.failures += 1;
    state.lastFailure = now;
    if (state.failures >= MAX_FAILURES) {
      state.lockedUntil = now + COOLDOWN_MS;
    }
    map[key] = state;
    writeMap(map);
  });
}
