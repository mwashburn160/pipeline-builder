// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Simple file-based rate limiter for auth operations.
 * Tracks failed attempts and enforces a cooldown period after too many failures.
 * State is persisted in a temp file so it survives across CLI invocations.
 */

const STATE_FILE = path.join(os.tmpdir(), '.pipeline-manager-auth-state.json');
const MAX_FAILURES = 5;
const COOLDOWN_MS = 60_000; // 1 minute

interface AuthState {
  failures: number;
  lastFailure: number;
  lockedUntil: number;
}

function readState(): AuthState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as AuthState;
    }
  } catch { /* ignore corrupt state */ }
  return { failures: 0, lastFailure: 0, lockedUntil: 0 };
}

function writeState(state: AuthState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch { /* best-effort */ }
}

/**
 * Check if auth attempts are currently rate-limited.
 * @returns null if allowed, or a message string if blocked.
 */
export function checkAuthRateLimit(): string | null {
  const state = readState();
  const now = Date.now();

  if (state.lockedUntil > now) {
    const waitSec = Math.ceil((state.lockedUntil - now) / 1000);
    return `Too many failed login attempts. Try again in ${waitSec}s.`;
  }

  // Reset if cooldown has passed
  if (now - state.lastFailure > COOLDOWN_MS) {
    writeState({ failures: 0, lastFailure: 0, lockedUntil: 0 });
  }

  return null;
}

/**
 * Record a successful auth — resets the failure counter.
 */
export function recordAuthSuccess(): void {
  writeState({ failures: 0, lastFailure: 0, lockedUntil: 0 });
}

/**
 * Record a failed auth attempt. After MAX_FAILURES, locks out for COOLDOWN_MS.
 */
export function recordAuthFailure(): void {
  const state = readState();
  const now = Date.now();
  state.failures += 1;
  state.lastFailure = now;

  if (state.failures >= MAX_FAILURES) {
    state.lockedUntil = now + COOLDOWN_MS;
  }

  writeState(state);
}
