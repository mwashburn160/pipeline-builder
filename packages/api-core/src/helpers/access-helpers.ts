// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Request, Response } from 'express';
import { isSystemAdmin, userHasPermission } from '../middleware/auth.js';
import { ErrorCode } from '../types/error-codes.js';
import type { Permission } from '../types/permissions.js';
import type { Visibility } from '../types/visibility.js';
import { sendError } from '../utils/response.js';

/** The slice of a catalog entity the write gate needs. */
export interface VisibilityWriteTarget {
  /** Rung the row currently sits at — see {@link Visibility}. */
  visibility?: string;
  /** Author. The only non-admin who may touch a `private` row. */
  createdBy?: string;
}

/**
 * Check whether the caller may modify a catalog entity, per its visibility rung.
 * The single write gate behind every pipeline / plugin / template mutation.
 *
 * - `public` — a system admin, or the holder of `publishPermission` (the same
 *   permission that let them publish it in the first place, so whoever can
 *   publish can also manage what they published)
 * - `org` — anyone who got this far: the resource's `:write` permission plus the
 *   org scoping the caller already passed IS the gate
 * - `private` — the AUTHOR alone (plus system admins)
 *
 * The `private` branch is load-bearing on the TOMBSTONE paths (restore / purge),
 * which are org-scoped rather than visibility-scoped because soft-delete is one
 * shared code path — without it, any org member could resurrect someone else's
 * personal draft. On the live paths the read predicate has already hidden the
 * row, making this defense in depth.
 *
 * Returns `true` if the request may proceed; returns `false` having ALREADY sent
 * a 403.
 *
 * @example
 * ```typescript
 * if (!requireVisibilityWriteAccess(req, res, pipeline, userId, 'pipelines:publish')) return;
 * await pipelineService.delete(id, orgId, userId);
 * ```
 */
export function requireVisibilityWriteAccess(
  req: Request,
  res: Response,
  resource: VisibilityWriteTarget,
  userId: string,
  publishPermission: Permission,
): boolean {
  if (isSystemAdmin(req)) return true;

  if (resource.visibility === 'public' && !userHasPermission(req, publishPermission)) {
    sendError(
      res,
      403,
      'You lack permission to modify this public resource.',
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
    return false;
  }

  // Fail closed on an anonymous/absent caller — an empty userId must never match
  // an empty `createdBy` and hand over someone else's draft.
  if (resource.visibility === 'private' && (!userId || resource.createdBy !== userId)) {
    sendError(
      res,
      403,
      'Only the author can modify a private resource.',
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
    return false;
  }

  return true;
}

/**
 * Resolve the effective visibility for an entity being created or updated.
 *
 * `public` requires the publish capability (superadmins pass via implicit-all);
 * a caller who asks for it without the permission is clamped to `org` rather
 * than dropped to a personal draft — they asked to SHARE it, and `org` is the
 * widest rung they are entitled to. Anything else passes through.
 *
 * `fallback` is the rung an UNSPECIFIED visibility lands on, and it is
 * deliberately per-entity even though the ladder itself is identical everywhere:
 *
 * - **templates** default to `private` — draft-first is the whole point of the
 *   personal rung; you polish a starter before publishing it.
 * - **pipelines / plugins** default to `org` — they are team assets that deploy
 *   shared infrastructure, so creating one must not hide it from the team. A
 *   personal draft stays available, but opt-in.
 *
 * Same ladder, same gate, different centre of gravity — expressed as an argument
 * rather than a second code path.
 *
 * Permission-based (not coarse-role-based): a bespoke custom Role can be granted
 * publish rights and is no longer forced private by its `member` label. Built-in
 * Admin/Owner bundles carry the publish permissions; the built-in Member bundle
 * does not, so members top out at `org`.
 */
export function resolveVisibility(
  req: Request,
  requested: string | undefined,
  publishPermission: Permission,
  fallback: Visibility = 'private',
): Visibility {
  if (requested === 'public') {
    return userHasPermission(req, publishPermission) ? 'public' : 'org';
  }
  if (requested === 'org') return 'org';
  if (requested === 'private') return 'private';
  return fallback;
}
