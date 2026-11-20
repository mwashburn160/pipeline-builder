// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-name lock a by-name delete, restore or purge holds for its whole run
 * (routes/plugin-by-name.ts), so nothing new lands under the name meanwhile.
 *
 * A Redis key (`SET NX PX` on the build queue's db-0 connection, the same
 * connection {@link withJobLock} uses), because the uploads and builds it has
 * to keep out run on every replica. The key lives
 * {@link PLUGIN_NAME_LOCK_TTL_MS} and is refreshed every third of that while
 * the holder runs, so a holder that dies frees the name on its own; the
 * release is compare-and-delete on the holder's token, so an expired lock
 * someone else re-took is never dropped.
 *
 * Who refuses while it is held, with 409 `PLUGIN_NAME_LOCKED`:
 * - `POST /plugins` (routes/upload-plugin.ts) before anything is staged;
 * - the build success tail (services/version-persist.ts) before a version is
 *   stored, so a build already running when the delete started never lands
 *   a version after it.
 *
 * Org ids are lowercased and names are used as stored (names are lowercase by
 * the spec schema), so a key never differs by case from the rows it guards.
 */

import { randomUUID } from 'node:crypto';

import { AppError, createLogger, ErrorCode, errorMessage, PLUGIN_DELETE_INFLIGHT_WAIT_MS } from '@pipeline-builder/api-core';

// A namespace import: suites that mock the queue connections with only the
// exports they use still link this module.
import * as connections from '../queue/connections.js';

const logger = createLogger('plugin-name-lock');

/**
 * How long a lock outlives a holder that stopped refreshing it: the longest the
 * by-name delete waits for running builds, plus room for the deletes after.
 */
export const PLUGIN_NAME_LOCK_TTL_MS = PLUGIN_DELETE_INFLIGHT_WAIT_MS + 300_000;

/** Delete the lock only while it still holds OUR token. */
const RELEASE_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
/** Extend the lock only while it still holds OUR token. */
const REFRESH_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

/** The Redis key of one org's name lock. */
export function pluginNameLockKey(orgId: string, name: string): string {
  return `plugin-name-lock:${orgId.toLowerCase()}:${name}`;
}

/** 409 PLUGIN_NAME_LOCKED: a by-name delete, restore or purge of `name` is running. */
export function pluginNameLockedError(name: string): AppError {
  return new AppError(409, ErrorCode.PLUGIN_NAME_LOCKED,
    `Plugin "${name}" is being deleted, restored or purged; try again once that finishes.`, { name });
}

/**
 * Run `fn` holding the org's lock on `name`. Throws {@link pluginNameLockedError}
 * without calling `fn` when another holder has it. The lock is released when
 * `fn` settles, either way; a failed release is logged and the TTL frees it.
 */
export async function withPluginNameLock<T>(orgId: string, name: string, fn: () => Promise<T>): Promise<T> {
  const redis = connections.getConnectionForDb(0);
  const key = pluginNameLockKey(orgId, name);
  const token = randomUUID();
  const ok = await redis.set(key, token, 'PX', PLUGIN_NAME_LOCK_TTL_MS, 'NX');
  if (ok !== 'OK') throw pluginNameLockedError(name);
  const refresh = setInterval(() => {
    redis.eval(REFRESH_LUA, 1, key, token, String(PLUGIN_NAME_LOCK_TTL_MS)).catch((err: unknown) => {
      logger.warn('Could not refresh a plugin name lock; it expires on its TTL', { orgId, name, error: errorMessage(err) });
    });
  }, Math.floor(PLUGIN_NAME_LOCK_TTL_MS / 3));
  refresh.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(refresh);
    try {
      await redis.eval(RELEASE_LUA, 1, key, token);
    } catch (err) {
      logger.warn('Could not release a plugin name lock; it expires on its TTL', { orgId, name, error: errorMessage(err) });
    }
  }
}

/**
 * Whether a by-name delete, restore or purge holds `name`. Fails OPEN (false,
 * logged) when Redis can't answer: the holder's own checks still refuse what
 * it must, and an upload is not the place to turn a Redis blip into an outage.
 */
export async function isPluginNameLocked(orgId: string, name: string): Promise<boolean> {
  try {
    return (await connections.getConnectionForDb(0).exists(pluginNameLockKey(orgId, name))) > 0;
  } catch (err) {
    logger.warn('Plugin name lock unreadable; treating the name as unlocked', { orgId, name, error: errorMessage(err) });
    return false;
  }
}

/**
 * Throw {@link pluginNameLockedError} when `name` is locked in the org. The
 * error is named `UnrecoverableError`, which BullMQ honours by name: a build
 * refused here is TERMINAL (slot refunded, context cleaned) rather than retried
 * into a version that lands once the delete has finished. It is still an
 * {@link AppError}, so a route answers it as the 409 it is.
 */
export async function assertPluginNameUnlocked(orgId: string, name: string): Promise<void> {
  if (await isPluginNameLocked(orgId, name)) throw Object.assign(pluginNameLockedError(name), { name: 'UnrecoverableError' });
}
