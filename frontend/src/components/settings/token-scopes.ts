// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PERMISSION_CATALOG, READ_ONLY_PERMISSIONS, permissionLabel } from '@pipeline-builder/api-core/permissions';

/**
 * Capability scopes a credential may carry INSTEAD of its holder's roles.
 * A scoped credential exchanges to a token with no permissions at all, so it can
 * do the one thing named here and nothing else — which is what every automation
 * that does exactly one thing should hold.
 *
 * Mirrors api-core's `TOKEN_SCOPES` (the set both `POST /user/generate-token`
 * and the service-account key route validate against); a value outside it is
 * refused by the API. Kept here rather than imported because api-core's root
 * entry is server-side code.
 */
export const TOKEN_SCOPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'reporting:ingest', label: 'reporting:ingest — post pipeline events / incidents' },
  { value: 'registry:push', label: 'registry:push — push images to this org’s namespace' },
  { value: 'scim', label: 'scim — provision members from your identity provider (SCIM 2.0)' },
];

/** Longest lifetime the API accepts for a machine token or key, in days. */
export const MAX_CREDENTIAL_DAYS = 365;

// ---------------------------------------------------------------------------
// Catalog-scoped credentials ("Selected permissions")
// ---------------------------------------------------------------------------

/** Whether a new credential carries the holder's full permissions or a chosen subset. */
export type PermissionMode = 'selected' | 'full';

/**
 * The read-only preset a new key STARTS from: every `:read` permission the
 * person actually holds (a subset may only name permissions they hold — the
 * API refuses anything else).
 */
export function readOnlyPreset(held: readonly string[]): string[] {
  const mine = new Set(held);
  return READ_ONLY_PERMISSIONS.filter((p) => mine.has(p));
}

/** A selection in catalog order (so what is sent — and shown — is stable). */
export function inCatalogOrder(selected: Iterable<string>): string[] {
  const wanted = new Set(selected);
  return PERMISSION_CATALOG.map((p) => p.id).filter((id) => wanted.has(id));
}

/**
 * One-line summary of a credential's authority for a list row: its capability
 * scope, "Full access", or its selected permissions by name.
 */
export function describeCredentialAuthority(k: { scope: string | null; permissions: string[] | null }): string {
  if (k.scope) return k.scope;
  if (!k.permissions) return 'Full access (your current permissions)';
  if (k.permissions.length === 0) return 'No permissions';
  return k.permissions.map((p) => permissionLabel(p)).join(', ');
}
