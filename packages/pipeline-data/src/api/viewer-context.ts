// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Viewer identity for app-layer predicates that carry a PER-USER rung.
 *
 * Most visibility predicates are org-grained, which RLS and the shared
 * access-control builder already express. Two entities need finer grain:
 *
 *  - **pipeline templates** — the `private` rung is author-only (`created_by`)
 *  - **messages** — a per-user targeted row (`recipient_user_id`) is visible
 *    only to its target, not to everyone in the recipient org
 *
 * Both need to know WHO is asking, and neither can get it from `CrudService`'s
 * signatures: `writeConditions` (update/delete) builds the read clause from a
 * bare `{ id }` filter and has nowhere to pass a viewer. Hand-threading the
 * viewer through every call site is the alternative, and it fails in practice —
 * it produces parallel `find*Visible*` methods and silently drops the viewer at
 * whichever call site forgets it (an org member then reads a row addressed to
 * someone else).
 *
 * So the viewer travels the same trusted, request-scoped channel as the org
 * stamp: `TenantContext`, set once at the request boundary from the validated
 * JWT. A service opts in by stamping it in ONE place — its `buildConditions`
 * override, which every read and write funnels through, including direct
 * `this.buildConditions(...)` calls.
 *
 * Fails CLOSED everywhere: no tenant scope (background jobs, migrations, the
 * retention sweep) means no viewer, and a viewer-less predicate must match
 * nothing on the per-user rung rather than matching everything.
 */

import { getTenantContext } from '../database/tenancy.js';

/** The viewer fields a per-user predicate reads off a filter. */
export interface ViewerScopedFilter {
  /** Caller's user id. Compared against the row's per-user column. */
  readonly viewerUserId?: string;
  /** Whether the caller is a platform super-admin (sees every rung). */
  readonly viewerIsSuperAdmin?: boolean;
}

/** The current request's user id, or `undefined` outside a tenant scope. */
export function currentViewerUserId(): string | undefined {
  return getTenantContext()?.userId;
}

/**
 * The viewer's identity as a CACHE-KEY segment.
 *
 * Any cache in front of a read whose predicate carries the per-user rung must
 * include this, because the viewer is part of the answer, not just part of the
 * authorization: `visibility <> 'private' OR created_by = V` returns different
 * rows to two members of the same org. Keyed on org alone, the first reader
 * populates the entry and every later one is served THEIR row — which is how an
 * author's private pipeline (and its `props`, holding source tokens and env)
 * reached the rest of the org.
 *
 * Super-admins collapse to one bucket: the private rung is lifted for all of
 * them, so their slice is identical and per-operator entries would only waste
 * space. Fails CLOSED-ish on an absent viewer by keying a distinct `none`
 * bucket, so a viewer-less read (background job, migration) can neither read nor
 * poison an authed caller's entry.
 */
export function viewerCacheSegment(): string {
  const ctx = getTenantContext();
  if (ctx?.isSuperAdmin) return 'sa';
  return ctx?.userId ?? 'none';
}

/** The viewer fields only the request context may set. */
const VIEWER_FIELDS = ['viewerUserId', 'viewerIsSuperAdmin'] as const satisfies ReadonlyArray<keyof ViewerScopedFilter>;

/**
 * Stamp the request's viewer identity onto a filter.
 *
 * The viewer is IDENTITY, and identity comes only from the request: the
 * `TenantContext` set at the request boundary from the validated JWT. A filter
 * that names a viewer (`viewerUserId`, `viewerIsSuperAdmin`) is REFUSED with a
 * thrown error rather than honoured — honoured, it let a caller read the rows
 * addressed to another user, or lift the private rung for a non-super-admin,
 * by putting a value in a filter. There is no workspace caller that needs to
 * scope to a different viewer; one that does must get an explicit, typed
 * option, not a filter field. An explicitly-`undefined` field counts as absent.
 *
 * Safe against `CrudService.runRead`'s sysadmin widening (the parent-org read
 * path, which re-enters the context with `isSuperAdmin: true`): conditions are
 * always built BEFORE that scope is entered, so the stamp reflects the real
 * caller, never the widened one.
 *
 * @throws Error when the filter carries a viewer field.
 *
 * @example
 * ```typescript
 * protected buildConditions(filter, orgId, parentOrgId) {
 *   return buildXConditions(withViewerContext(filter), orgId, parentOrgId);
 * }
 * ```
 */
export function withViewerContext<F extends ViewerScopedFilter>(filter: Partial<F>): Partial<F> {
  const supplied = VIEWER_FIELDS.filter((field) => filter[field] !== undefined);
  if (supplied.length > 0) {
    throw new Error(
      `withViewerContext: ${supplied.join(', ')} must not be set on a filter — the viewer comes only from the request's tenant context`,
    );
  }
  const ctx = getTenantContext();
  return {
    ...filter,
    viewerUserId: ctx?.userId,
    viewerIsSuperAdmin: ctx?.isSuperAdmin ?? false,
  };
}
