// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Path-scoped writes to a subscription's `metadata` (a Mixed object).
 *
 * Several writers share `metadata` CONCURRENTLY, each with its own atomic
 * dot-path `$set` / `$unset`: the provider add-on resync marker
 * (`providerAddonSyncPending` — what stops a removed bundle being billed
 * forever), the discount apply claim, the Marketplace drawdown hour, the
 * stale-period key. Replacing the whole object on a loaded document
 * (`subscription.metadata = { ...rest }`) makes the next `save()` write every key
 * it had READ back, erasing any marker another writer set in between. Setting
 * one path makes the save write exactly that path.
 */

type WithMetadata = { metadata?: Record<string, unknown> | null };
type MongooseLike = WithMetadata & { set?: (path: string, value: unknown) => unknown };

/** Set (or, with `undefined`, remove) ONE `metadata` key, touching no other. */
export function setMetadataKey(subscription: WithMetadata, key: string, value: unknown): void {
  const doc = subscription as MongooseLike;
  if (typeof doc.set === 'function') {
    doc.set(`metadata.${key}`, value);
    return;
  }
  // A plain object (a lean read, a test fixture): mutate in place.
  const metadata = { ...(subscription.metadata ?? {}) };
  if (value === undefined) delete metadata[key];
  else metadata[key] = value;
  subscription.metadata = metadata;
}
