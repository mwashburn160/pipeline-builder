// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Before → after for the fields a compliance UPDATE changed, for the audit
 * row's `details.changes`. An update that only says "rule X was updated"
 * cannot answer the question a reviewer actually has — what did the condition
 * say before, and who loosened it — so the enforcement-bearing fields carry
 * their old and new values.
 *
 * Only the `fields` named are compared (never free text such as a description),
 * and only the ones that differ are returned. Dates compare by instant and are
 * recorded as ISO strings; structured values (conditions, tags) by their JSON.
 */
export function auditedChanges(
  before: object | null | undefined,
  after: object,
  fields: readonly string[],
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (!before) return changes;
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  for (const field of fields) {
    const from = normalise(b[field]);
    const to = normalise(a[field]);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = { from, to };
  }
  return changes;
}

function normalise(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v ?? null;
}
