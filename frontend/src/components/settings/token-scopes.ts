// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BadgeColor } from '@/components/ui/Badge';
import { PERMISSION_CATALOG, READ_ONLY_PERMISSIONS, permissionLabel } from '@pipeline-builder/api-core/permissions';
import type { TokenScope } from '@pipeline-builder/api-core';
import type { CredentialStatus } from '@/lib/api/domains/auth';

/**
 * What each capability scope LETS a credential do, keyed by the scope itself.
 *
 * A scoped credential exchanges to a token with no permissions at all, so it can
 * do the one thing named here and nothing else — which is what every automation
 * that does exactly one thing should hold.
 *
 * `Record<TokenScope, string>` keys this off api-core's own union — the set both
 * `POST /user/generate-token` and the service-account key route validate
 * against — so a scope added or removed there is a COMPILE ERROR here rather
 * than a picker that silently omits the new scope, or offers one the API
 * refuses. The import is type-only, so nothing of api-core's server-side root
 * entry reaches the bundle; the previous hand-written list was kept local for
 * exactly that reason and paid for it with a "mirrors api-core" comment.
 *
 * Only the COPY is local, which is right: the backend has no display wording.
 */
const TOKEN_SCOPE_DESCRIPTIONS: Record<TokenScope, string> = {
  'reporting:ingest': 'post pipeline events / incidents',
  'registry:push': 'push images to this org’s namespace',
  scim: 'provision members from your identity provider (SCIM 2.0)',
};

/** The scope picker's options, in catalog order. */
export const TOKEN_SCOPE_OPTIONS: ReadonlyArray<{ value: TokenScope; label: string }> =
  (Object.keys(TOKEN_SCOPE_DESCRIPTIONS) as TokenScope[])
    .map((value) => ({ value, label: `${value} — ${TOKEN_SCOPE_DESCRIPTIONS[value]}` }));

/** Badge tone for a credential's lifecycle status. Shared by the access-key
 *  table and the machine-token history so the two can't drift. */
export const CREDENTIAL_STATUS_COLOR: Record<CredentialStatus, BadgeColor> = {
  active: 'green',
  expired: 'gray',
  revoked: 'red',
};

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
