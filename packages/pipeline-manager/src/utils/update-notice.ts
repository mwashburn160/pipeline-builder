// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "A newer pipeline-manager is available" — printed to stderr when a command
 * exits, from a cache refreshed at most once a day by a DETACHED background
 * process, so no command ever waits on the registry.
 *
 * Silent when: `PIPELINE_MANAGER_NO_UPDATE_CHECK` is set, `CI` is set, stderr
 * is not a terminal, `--quiet` / `--token` output is wanted, or the command is
 * itself `--upgrade` / `--upgrade-check`. It never fails a command: every
 * error here is swallowed.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { compareSemver, isSemver } from '@pipeline-builder/api-core';
import pico from 'picocolors';
import { APP_NAME, APP_VERSION } from '../config/cli.constants.js';

export const NO_UPDATE_CHECK_ENV = 'PIPELINE_MANAGER_NO_UPDATE_CHECK';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PACKAGE_NAME = '@pipeline-builder/pipeline-manager';

export interface UpdateCache { checkedAt: number; latest?: string }

export interface NoticeContext {
  argv: string[];
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
}

/** Whether the notice (and its background refresh) may run at all. */
export function updateCheckEnabled({ argv, env, isTTY }: NoticeContext): boolean {
  if (env[NO_UPDATE_CHECK_ENV] || env.CI || env.NODE_ENV === 'test') return false;
  if (!isTTY) return false;
  return !argv.some((a) => a === '--quiet' || a === '--token' || a === '--upgrade' || a === '--upgrade-check');
}

/** The notice line for `current` given the cache, or null when there is nothing newer. */
export function noticeFor(current: string, cache: UpdateCache | null): string | null {
  const latest = cache?.latest;
  if (!latest || !isSemver(latest) || !isSemver(current)) return null;
  if (compareSemver(latest, current) <= 0) return null;
  return `${pico.yellow('Update available')} ${current} → ${pico.green(latest)}: run ${pico.cyan(`${APP_NAME} --upgrade`)}`
    + pico.dim(` (silence with ${NO_UPDATE_CHECK_ENV}=1)`);
}

/** Whether the cache is due for a refresh at `now`. */
export function isStale(cache: UpdateCache | null, now: number): boolean {
  return !cache || !Number.isFinite(cache.checkedAt) || now - cache.checkedAt >= CHECK_INTERVAL_MS || cache.checkedAt > now;
}

export function readCache(file: string): UpdateCache | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as UpdateCache;
    return typeof parsed.checkedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The detached refresher: asks the registry for `latest` and writes the cache.
 * It stamps `checkedAt` even when the lookup fails, so an offline machine
 * retries tomorrow rather than on every command.
 */
const REFRESH_SCRIPT = `
const { execFileSync } = require('node:child_process');
const { writeFileSync, renameSync } = require('node:fs');
const [file, pkg] = process.argv.slice(1);
let latest;
try {
  const out = execFileSync('npm', ['view', pkg + '@latest', 'version', '--json'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
  const v = JSON.parse(out);
  if (typeof v === 'string') latest = v;
} catch {}
const tmp = file + '.' + process.pid;
writeFileSync(tmp, JSON.stringify({ checkedAt: Date.now(), latest }));
renameSync(tmp, file);
`;

export function defaultCacheFile(): string {
  return join(homedir(), '.pipeline-manager', 'update-check.json');
}

/**
 * Wire the notice for this process: read the cache now, refresh it in the
 * background when stale, and print on exit when a newer release is known.
 */
export function scheduleUpdateNotice(
  ctx: NoticeContext = { argv: process.argv.slice(2), env: process.env, isTTY: Boolean(process.stderr.isTTY) },
  file: string = defaultCacheFile(),
  now: number = Date.now(),
): void {
  try {
    if (!updateCheckEnabled(ctx)) return;
    const cache = readCache(file);
    if (isStale(cache, now)) {
      // ~/.pipeline-manager is also the CREDENTIAL store (credential-store.ts
      // makes it 0700, but only when creating it) — if this runs first it must
      // not leave that directory world-readable.
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      spawn(process.execPath, ['-e', REFRESH_SCRIPT, file, PACKAGE_NAME], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    const line = noticeFor(APP_VERSION, cache);
    if (line) process.once('exit', () => { process.stderr.write(`\n${line}\n`); });
  } catch {
    // Never let the update notice break a command.
  }
}
