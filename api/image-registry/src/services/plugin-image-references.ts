// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The image digests an org's `org-<id>/*` namespace still needs, from the plugin
 * service (`GET /internal/plugins/image-references?orgId=`): every plugin row's
 * digest — active, inactive or soft-deleted — and every digest a pipeline of the
 * org or its teams declares, runs, or has an open deployed exposure on.
 *
 * The age GC consults it before deleting anything: a referenced image is never
 * deleted, whatever its age (a pipeline would fail its next pull — and a
 * VULNERABLE image is the worst one to take away; vulnerability state is graded
 * and notified, never removed). It FAILS SAFE: when the set cannot be read, the
 * caller deletes nothing in that namespace for the pass. Not cached: one read per
 * namespace per GC pass.
 */

import { getServiceAuthHeader, InternalHttpClient, serviceEndpoint, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';

type Fetcher = (orgId: string) => Promise<string[]>;

const liveFetcher: Fetcher = async (orgId) => {
  const client = new InternalHttpClient(serviceEndpoint('plugin'));
  const res = await client.get<{ data?: { digests?: unknown } }>(`/internal/plugins/image-references?orgId=${encodeURIComponent(orgId)}`, {
    headers: { Authorization: getServiceAuthHeader({ serviceName: 'image-registry', orgId: SYSTEM_ORG_ID, role: 'member' }) },
  });
  if (res.statusCode !== 200) throw new Error(`plugin service answered HTTP ${res.statusCode}`);
  const digests = res.body?.data?.digests;
  if (!Array.isArray(digests)) throw new Error('plugin service answered without a digests list');
  return digests.filter((d): d is string => typeof d === 'string');
};

let fetcher: Fetcher = liveFetcher;

/** Test hook: replace the plugin-service read (pass nothing to restore it). */
export function setPluginImageReferencesFetcherForTests(f?: Fetcher): void {
  fetcher = f ?? liveFetcher;
}

/** The digests `orgId`'s namespace still needs. THROWS when they cannot be read — the caller must then delete nothing. */
export async function pluginImageReferences(orgId: string): Promise<ReadonlySet<string>> {
  return new Set(await fetcher(orgId));
}
