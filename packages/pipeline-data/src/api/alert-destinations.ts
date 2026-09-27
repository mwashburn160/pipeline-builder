// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading an org's notification destinations.
 *
 * These rows are ADMIN-OWNED: an org's admins decided where this organization's
 * notifications go, and everything that needs to notify an org reads the same list
 * rather than growing its own copy. Platform owns the writes (create, update, test,
 * delete) in its alert-destination service; this is the read, here so that a service
 * with no Drizzle dependency of its own can use it.
 *
 * Whoever reads this list must not treat it as a URL they chose. A caller that let a
 * user name the target would have reinvented an SSRF, which is exactly why the write
 * side validates the channel/target pairing and the transport resolves-and-pins the host.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../database/drizzle-schema.js';
import { withTenantTx } from '../database/tenancy.js';

/** One destination, reduced to what a delivery needs. */
export interface NotificationDestination {
  id: string;
  /** `slack` | `webhook` | `email` | `in-app`. */
  channel: string;
  /** The URL or address. Bearer-equivalent for a webhook — never logged. */
  target: string;
  label: string;
}

/**
 * Every ENABLED, undeleted destination for an org.
 *
 * Runs in the caller's ambient tenant context, so RLS is the tenancy gate — a caller
 * without a context for this org reads nothing, which is the correct answer rather than
 * an error.
 */
export async function listEnabledAlertDestinations(orgId: string): Promise<NotificationDestination[]> {
  const rows = await withTenantTx((tx) => tx.select({
    id: schema.orgAlertDestination.id,
    channel: schema.orgAlertDestination.channel,
    target: schema.orgAlertDestination.target,
    label: schema.orgAlertDestination.label,
  }).from(schema.orgAlertDestination)
    .where(and(
      eq(schema.orgAlertDestination.orgId, orgId),
      eq(schema.orgAlertDestination.enabled, true),
      isNull(schema.orgAlertDestination.deletedAt),
    )));
  return rows as NotificationDestination[];
}
