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
const MAX_FAILURES = 5;
const COOLDOWN_MS = 60_000; // 1 minute
const PRUNE_MS = 60 * 60_000; // drop buckets idle for >1h to bound file growth

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
    fs.writeFileSync(STATE_FILE, JSON.stringify(map), { mode: 0o600 });
  } catch { /* best-effort */ }
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

  // Reset this bucket once the cooldown window has passed.
  if (state.lastFailure !== 0 && now - state.lastFailure > COOLDOWN_MS) {
    delete map[key];
    writeMap(map);
  }

  return null;
}

/**
 * Record a successful auth for this identifier — clears its failure counter.
 */
export function recordAuthSuccess(identifier?: string, baseUrl?: string): void {
  const map = readMap();
  delete map[keyFor(identifier, baseUrl)];
  writeMap(map);
}

/**
 * Record a failed auth attempt for this identifier. After MAX_FAILURES, locks out
 * that identifier for COOLDOWN_MS.
 */
export function recordAuthFailure(identifier?: string, baseUrl?: string): void {
  const key = keyFor(identifier, baseUrl);
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
}
