// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AccessModifier, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { db, schema } from '@pipeline-builder/pipeline-core';
import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';

/**
 * Visibility predicate for active, public plugins owned by the caller's org
 * or by the system org. Shared by every read path in this service that
 * needs the "what plugins can this org see?" filter.
 */
export function availablePluginConditions(orgId: string): SQL[] {
  return [
    eq(schema.plugin.isActive, true),
    isNull(schema.plugin.deletedAt),
    eq(schema.plugin.accessModifier, AccessModifier.PUBLIC),
    or(eq(schema.plugin.orgId, orgId), eq(schema.plugin.orgId, SYSTEM_ORG_ID))!,
  ];
}

/**
 * Return the subset of `names` that already exist as active, public plugins
 * visible to the given org (own org or system). One round-trip instead of N.
 */
export async function findExistingPluginNames(names: string[], orgId: string): Promise<Set<string>> {
  if (names.length === 0) return new Set();

  const rows = await db
    .select({ name: schema.plugin.name })
    .from(schema.plugin)
    .where(and(inArray(schema.plugin.name, names), ...availablePluginConditions(orgId)));

  return new Set(rows.map(r => r.name));
}
