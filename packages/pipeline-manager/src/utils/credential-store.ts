// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * On-disk session store for `auth login`.
 *
 * `~/.pipeline-manager/credentials.json`, owner-only (0600 file inside the 0700
 * directory the audit log already creates), keyed by platform base URL so one
 * machine can hold sessions for several platforms at once.
 *
 * It holds a real session — the access token AND its refresh token — because
 * that is what the device flow hands back and what lets the CLI keep working for
 * days without another browser round trip. Nothing else about the account is
 * stored: no password (the CLI never holds one) and no identifier.
 *
 * Resolution order everywhere else in the CLI is unchanged in spirit: an
 * explicit `PLATFORM_TOKEN` in the environment always wins, so CI keeps using an
 * access key and is never affected by whatever a developer's laptop has cached.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { errorMessage } from '@pipeline-builder/api-core';
import { printDebug, printWarning } from './output-utils.js';

const STORE_DIR = path.join(os.homedir(), '.pipeline-manager');
const STORE_FILE = path.join(STORE_DIR, 'credentials.json');
const REFRESH_LOCK_FILE = path.join(STORE_DIR, 'refresh.lock');

/** A lock older than this belongs to a process that died mid-refresh. */
const REFRESH_LOCK_STALE_MS = 30_000;
/** How long a second process waits for the first one's refresh to finish. */
const REFRESH_LOCK_WAIT_MS = 15_000;
const REFRESH_LOCK_POLL_MS = 100;

/** Re-authenticate rather than hand out a token this close to expiry. */
const EXPIRY_SKEW_MS = 60_000;

/** One platform's stored session. */
export interface StoredSession {
  accessToken: string;
  /** Rotated on every refresh; absent only if the platform stopped issuing one. */
  refreshToken?: string;
  /** Epoch ms the access token expires. */
  expiresAt: number;
  /** The org the session was scoped to when it was stored (informational). */
  organizationId?: string;
  savedAt: string;
}

interface StoreFile {
  version: 1;
  sessions: Record<string, StoredSession>;
}

/** Where the sessions live — surfaced in help text and errors. */
export function credentialStorePath(): string {
  return STORE_FILE;
}

/**
 * Trailing slashes and case differences in the host would otherwise split one
 * platform into several entries.
 */
function storeKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').toLowerCase();
}

function readStore(): StoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === 'object') {
      return parsed as StoreFile;
    }
  } catch {
    // Missing or unreadable: treat as empty. A corrupt file must not break every
    // command — the next successful login rewrites it.
  }
  return { version: 1, sessions: {} };
}

function writeStore(store: StoreFile): void {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  // Write through a temp file so an interrupted write can't leave a truncated
  // store behind, and create it 0600 from the start (never briefly world-readable).
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}

/** Persist the session for `baseUrl`, replacing any previous one. */
export function saveSession(baseUrl: string, session: Omit<StoredSession, 'savedAt'>): void {
  const store = readStore();
  store.sessions[storeKey(baseUrl)] = { ...session, savedAt: new Date().toISOString() };
  writeStore(store);
  printDebug('Session stored', { path: STORE_FILE, platform: storeKey(baseUrl) });
}

/** The stored session for `baseUrl`, or undefined. Expiry is NOT checked here —
 *  callers decide whether to use, refresh or ignore it. */
export function loadSession(baseUrl: string): StoredSession | undefined {
  return readStore().sessions[storeKey(baseUrl)];
}

/** Forget the session for `baseUrl` (sign-out, or a refresh the platform rejected). */
export function clearSession(baseUrl: string): void {
  const store = readStore();
  if (!(storeKey(baseUrl) in store.sessions)) return;
  delete store.sessions[storeKey(baseUrl)];
  try {
    writeStore(store);
  } catch (error) {
    // Losing the ability to clear a dead session is a nuisance, not a failure.
    printWarning('Could not update the stored credentials', {
      path: STORE_FILE,
      error: errorMessage(error),
    });
  }
}

/** True when the stored access token is still usable (with a little slack). */
export function isSessionUsable(session: StoredSession | undefined): session is StoredSession {
  return !!session?.accessToken && session.expiresAt - EXPIRY_SKEW_MS > Date.now();
}

/**
 * Run `fn` holding the machine-wide REFRESH LOCK (`~/.pipeline-manager/refresh.lock`,
 * created exclusively).
 *
 * A refresh token is single-use: two CLI processes renewing the same stored
 * session at once (a script fanning out commands, two terminals) would present
 * the same token twice, and outside the platform's short rotation grace the
 * second use reads as REUSE — which revokes the session. Serializing the refresh
 * means the second process waits, then (re-reading the store) finds the pair the
 * first one already saved instead of spending the old token again.
 *
 * A lock left behind by a crashed process is broken after
 * {@link REFRESH_LOCK_STALE_MS}; waiting gives up after {@link REFRESH_LOCK_WAIT_MS}
 * and runs `fn` anyway (the platform grace still covers a near-simultaneous use).
 */
export async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      fs.closeSync(fs.openSync(REFRESH_LOCK_FILE, 'wx', 0o600));
      held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') break; // can't lock at all — proceed unlocked
      try {
        if (Date.now() - fs.statSync(REFRESH_LOCK_FILE).mtimeMs > REFRESH_LOCK_STALE_MS) {
          fs.rmSync(REFRESH_LOCK_FILE, { force: true });
          continue;
        }
      } catch {
        continue; // vanished between open and stat — try again
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, REFRESH_LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    if (held) fs.rmSync(REFRESH_LOCK_FILE, { force: true });
  }
}
