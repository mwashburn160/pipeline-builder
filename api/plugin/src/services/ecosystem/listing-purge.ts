// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Purging a listing version, or removing a whole listing, together with the
 * kept sources stored for it under `plugin-sources/listings/<listingId>/…`
 * (services/plugin-sources.ts `deleteListingSources`).
 *
 * Those objects belong to no org: a listed version's source copy is made at
 * publish precisely so it outlives the publisher org's row. So neither the
 * org-version purge (`<orgId>/<pluginId>/<version>/`) nor the org purge
 * (`<orgId>/`) ever reaches them — every path that hard-deletes a listing
 * version or a listing goes through here, so its objects go with it. The row
 * goes first; a failed object delete never undoes it and lands in
 * `plugin_source_orphans` for the purge sweep to retry.
 */

import { listings, recomputeLatest, versions } from './store.js';
import { deleteListingSources } from '../plugin-sources.js';

/** Hard-delete one listing version and its kept sources. False when there was no such version. */
export async function purgeListingVersion(listingId: string, version: string): Promise<boolean> {
  const row = await versions.get(listingId, version);
  if (!row) return false;
  const removed = await versions.remove(row.id);
  if (!removed) return false;
  await recomputeLatest(listingId);
  await deleteListingSources({ listingId, version: removed.version });
  return true;
}

/** Hard-delete a listing (its versions cascade) and every version's kept sources. False when there was no such listing. */
export async function removeListing(listingId: string): Promise<boolean> {
  const removed = await listings.remove(listingId);
  if (!removed) return false;
  await deleteListingSources({ listingId: removed.id });
  return true;
}
