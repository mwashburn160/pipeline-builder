// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org id → display NAME enrichment for message responses.
 *
 * A message row stores only org IDs (`orgId` / `recipientOrgId`), but the inbox
 * and thread UI show the counterparty by NAME. Names live in Mongo behind the
 * platform service, so this reads them over HTTP (system-scoped service token)
 * through the shared api-core client and caches each id→name for the message
 * cache TTL.
 *
 * Best-effort throughout: any lookup failure leaves an id unresolved and the
 * client falls back to rendering the raw id — enrichment never blocks or fails a
 * message read. The HTTP mechanics (URL, signed service-token auth, retry) live
 * in api-core's {@link fetchOrgNames}; this module only adds the message
 * service's caching + row-shaping.
 */

import { createCacheService, fetchOrgNames, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

/** Per-id name cache — org names change rarely; a short TTL keeps them fresh. */
const orgNameCache = createCacheService('orgname:', 300);

/** Platform org-lookup options for the message service (system-scoped token). */
function nameLookupOptions() {
  const { services } = Config.get('server');
  return {
    service: { host: services.platformHost, port: services.platformPort },
    serviceName: 'message',
    // System-scoped service token: an internal read of the org registry, not a
    // tenant-scoped operation. Never carries an AWS account id.
    authOrgId: SYSTEM_ORG_ID,
  } as const;
}

/**
 * Resolve a set of org ids to a lowercased `id → name` map. Serves cache hits
 * first and batches the misses into ONE platform call. Fail-soft: a transport
 * error leaves the misses unresolved (absent from the map).
 */
async function resolveOrgNames(orgIds: Iterable<string>): Promise<Map<string, string>> {
  const wanted = [...new Set([...orgIds].map((id) => id.toLowerCase()))].filter((id) => id && id !== '*');
  const out = new Map<string, string>();
  const misses: string[] = [];

  await Promise.all(
    wanted.map(async (id) => {
      const cached = await orgNameCache.get<string>(id);
      if (typeof cached === 'string') out.set(id, cached);
      else misses.push(id);
    }),
  );

  if (misses.length > 0) {
    try {
      const fetched = await fetchOrgNames(misses, nameLookupOptions());
      for (const id of misses) {
        const name = fetched[id];
        if (name) {
          out.set(id, name);
          await orgNameCache.set(id, name);
        }
      }
    } catch {
      // Fail-soft: unresolved ids render as the raw id on the client.
    }
  }
  return out;
}

/** The org-name fields appended to each enriched message row. */
export type WithOrgNames<T> = T & { orgName?: string; recipientOrgName?: string };

/**
 * Attach `orgName` + `recipientOrgName` to a batch of message rows using a
 * single batched name lookup. The `'*'` broadcast recipient has no name and is
 * left unset. Original fields (including any embedded `attachments`) are
 * preserved.
 */
export async function enrichWithOrgNames<T extends { orgId: string; recipientOrgId?: string | null }>(
  rows: T[],
): Promise<Array<WithOrgNames<T>>> {
  if (rows.length === 0) return rows as Array<WithOrgNames<T>>;

  const ids = new Set<string>();
  for (const r of rows) {
    if (r.orgId) ids.add(r.orgId);
    if (r.recipientOrgId && r.recipientOrgId !== '*') ids.add(r.recipientOrgId);
  }
  const names = await resolveOrgNames(ids);

  return rows.map((r) => ({
    ...r,
    orgName: names.get(r.orgId.toLowerCase()),
    recipientOrgName:
      r.recipientOrgId && r.recipientOrgId !== '*' ? names.get(r.recipientOrgId.toLowerCase()) : undefined,
  }));
}

/** Single-row convenience wrapper around {@link enrichWithOrgNames}. */
export async function enrichOneWithOrgNames<T extends { orgId: string; recipientOrgId?: string | null }>(
  row: T,
): Promise<WithOrgNames<T>> {
  const [enriched] = await enrichWithOrgNames([row]);
  return enriched;
}
