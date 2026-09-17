// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { buildPluginConditions, schema, withTenantTx, withViewerContext, type PluginFilter } from '@pipeline-builder/pipeline-data';
import { and, inArray, isNull, type SQL } from 'drizzle-orm';

/**
 * Visibility predicate for the active plugins the CALLER can see — the shared
 * three-rung `visibility` ladder (see `AccessControlQueryBuilder.buildAccessControl`),
 * not a bespoke copy of it:
 *
 *   - own org: `org` + `public` rows, plus the caller's OWN `private` drafts
 *     (another member's private plugin stays invisible);
 *   - system org: `public` rows (the shared catalog every org sees).
 *
 * The viewer (user id / super-admin) is stamped from the request's tenant
 * context by `withViewerContext`, so this must run inside the request scope;
 * outside one the private rung fails closed (matches nothing).
 *
 * Shared by every read path in this service that needs the "what plugins can
 * this caller see?" filter (AI generation context + auto-create existence check).
 */
export function availablePluginConditions(orgId: string): SQL[] {
  return [
    ...buildPluginConditions(withViewerContext<PluginFilter>({}), orgId),
    isNull(schema.plugin.deletedAt),
  ];
}

/**
 * Return the subset of `names` that already exist as active plugins visible to
 * the caller (see {@link availablePluginConditions}). One round-trip instead of N.
 */
export async function findExistingPluginNames(names: string[], orgId: string): Promise<Set<string>> {
  if (names.length === 0) return new Set();

  // Wrap in withTenantTx so `app.org_id` is set — the `plugins` table is
  // FORCE ROW LEVEL SECURITY, and a bare `db.select()` runs with a null GUC,
  // collapsing the policy to system-org rows only and dropping the org's own.
  const rows = await withTenantTx(async (tx) => tx
    .select({ name: schema.plugin.name })
    .from(schema.plugin)
    .where(and(inArray(schema.plugin.name, names), ...availablePluginConditions(orgId))));

  return new Set(rows.map(r => r.name));
}
