// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry storage USAGE for the quota reads.
 *
 * `storageBytes` is the one quota nothing increments: the image-registry
 * measures an org's namespace live and enforces its push gate itself, so
 * `usage.storageBytes.used` is structurally 0 and the dashboard used to report
 * "0 B of 25 GB" for an org with a full registry. This fills `used` from the
 * registry's own measurement, for READS only (`findByOrgId` — the dashboard,
 * the per-org at-risk view). The enforcement read the registry itself makes
 * (`GET /quotas/:orgId/storageBytes`) never calls back into the registry.
 *
 * Contract: `GET /internal/storage-usage/:orgId` on the image-registry → `200
 * { data: { bytes } }`, service-token authenticated with `quota` as the caller.
 * Fail-soft: an unreachable registry, a non-2xx (including a registry that
 * doesn't serve the route) or a malformed body reads as "unknown" and the
 * caller keeps 0. Readings — and failures — are cached for
 * `QUOTA_STORAGE_USAGE_CACHE_TTL_MS`, so a down registry costs one attempt per
 * org per window, not one per dashboard poll.
 */

import { createLogger, createSafeClient, emitCounter, getServiceAuthHeader, serviceEndpoint } from '@pipeline-builder/api-core';
import { config } from '../config.js';

const logger = createLogger('storage-usage');

/** The registry's internal storage-usage route (one org's namespace, in bytes). */
export const REGISTRY_STORAGE_USAGE_PATH = '/internal/storage-usage';

interface CacheEntry { bytes: number | null; expires: number }
const cache = new Map<string, CacheEntry>();
const CACHE_MAX_ENTRIES = 10_000;

let client: ReturnType<typeof createSafeClient> | null = null;
function registryClient(): ReturnType<typeof createSafeClient> {
  client ??= createSafeClient({ ...serviceEndpoint('image-registry'), timeout: 3000 });
  return client;
}

/** Drop every cached reading (tests; also a safe operational reset). */
export function clearStorageUsageCache(): void {
  cache.clear();
}

/** One org's registry storage in bytes, or `null` when it could not be measured. */
export async function fetchOrgStorageBytes(orgId: string): Promise<number | null> {
  const now = Date.now();
  const hit = cache.get(orgId);
  if (hit && hit.expires > now) return hit.bytes;

  let bytes: number | null = null;
  try {
    const response = await registryClient().get<{ data?: { bytes?: unknown } }>(
      `${REGISTRY_STORAGE_USAGE_PATH}/${encodeURIComponent(orgId)}`,
      { headers: { authorization: getServiceAuthHeader({ serviceName: 'quota', orgId, role: 'member' }) }, maxRetries: 0 },
    );
    const raw = response?.statusCode === 200 ? response.body?.data?.bytes : undefined;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) bytes = raw;
    else emitCounter('quota_storage_usage_read_failed_total', { reason: response ? `http_${response.statusCode}` : 'unreachable' });
  } catch (err) {
    emitCounter('quota_storage_usage_read_failed_total', { reason: 'exception' });
    logger.debug('Registry storage usage unavailable', { orgId, error: String(err) });
  }

  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(orgId, { bytes, expires: now + config.quota.storageUsageCacheTtlMs });
  return bytes;
}

/**
 * Sum of the registry storage of every org in `orgIds` (a pool's subtree, or a
 * single flat org), or `null` when NONE of them could be measured. A partial
 * answer is still the better number than 0, so measured orgs are summed.
 */
export async function fetchStorageBytes(orgIds: string[]): Promise<number | null> {
  const readings = await Promise.all(orgIds.map(fetchOrgStorageBytes));
  const measured = readings.filter((b): b is number => b !== null);
  return measured.length > 0 ? measured.reduce((a, b) => a + b, 0) : null;
}
