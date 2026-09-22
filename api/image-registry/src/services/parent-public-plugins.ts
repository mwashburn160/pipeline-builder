// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which of an org's plugins are `public` — the only parent repositories a TEAM
 * may pull. A team resolves its parent's public plugins at lookup
 * (api/plugin read-plugins.ts), so its pipelines need those images; nothing else
 * in the parent's `org-<id>/*` namespace is theirs to pull.
 *
 * The plugin service owns plugin visibility, so the set comes from its internal
 * route `GET /internal/plugins/public-names?orgId=`. Cached per org for a
 * minute (bounded); a failed read yields an EMPTY set (fail closed: the pull
 * is refused, and a retry after the short failure TTL tries again).
 */

import { envInt, createLogger, errorMessage, getServiceAuthHeader, InternalHttpClient, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { TtlCache } from './ttl-cache.js';

const logger = createLogger('parent-public-plugins');

const TTL_MS = 60_000;
const FAILURE_TTL_MS = 10_000;
const MAX_ENTRIES = 1_000;

type Fetcher = (orgId: string) => Promise<string[]>;

const cache = new TtlCache<ReadonlySet<string>>(MAX_ENTRIES, TTL_MS);

const liveFetcher: Fetcher = async (orgId) => {
  const client = new InternalHttpClient({
    host: process.env.PLUGIN_SERVICE_HOST || 'plugin',
    port: envInt('PLUGIN_SERVICE_PORT', 3000, { min: 1, max: 65535 }),
    timeout: 5_000,
  });
  const res = await client.get<{ data?: { names?: unknown } }>(`/internal/plugins/public-names?orgId=${encodeURIComponent(orgId)}`, {
    headers: { Authorization: getServiceAuthHeader({ serviceName: 'image-registry', orgId: SYSTEM_ORG_ID, role: 'member' }) },
  });
  if (res.statusCode !== 200) throw new Error(`plugin service answered HTTP ${res.statusCode}`);
  const names = res.body?.data?.names;
  if (!Array.isArray(names)) throw new Error('plugin service answered without a names list');
  return names.filter((n): n is string => typeof n === 'string');
};

let fetcher: Fetcher = liveFetcher;

/** Test hook: replace the plugin-service read (pass nothing to restore it) and clear the cache. */
export function setParentPublicPluginsFetcherForTests(f?: Fetcher): void {
  fetcher = f ?? liveFetcher;
  cache.clear();
}

/** The names of `orgId`'s live `public` plugins (empty when they can't be read). */
export async function parentPublicPlugins(orgId: string): Promise<ReadonlySet<string>> {
  const hit = cache.get(orgId);
  if (hit) return hit;
  let names: ReadonlySet<string>;
  let ttl = TTL_MS;
  try {
    names = new Set(await fetcher(orgId));
  } catch (err) {
    logger.warn('Parent public-plugin set unavailable; refusing parent pulls', { orgId, error: errorMessage(err) });
    names = new Set();
    ttl = FAILURE_TTL_MS;
  }
  cache.set(orgId, names, ttl);
  return names;
}
