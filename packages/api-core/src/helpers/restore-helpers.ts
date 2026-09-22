// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Request, Response } from 'express';
import { requireVisibilityWriteAccess } from './access-helpers.js';
import { sendEntityNotFound } from './crud-helpers.js';
import { ErrorCode } from '../types/error-codes.js';
import type { Permission } from '../types/permissions.js';
import { getParam } from '../utils/params.js';
import { sendBadRequest } from '../utils/response.js';

/** Minimal shape a restore route needs from the entity it restores. */
export interface RestorableEntity {
  orgId: string;
  /** Rung the tombstone sat at — drives the restore/purge authority check. */
  visibility?: string;
  /** Author — the only non-admin who may restore/purge a `private` row. */
  createdBy?: string;
}

/** The slice of a service a restore route uses (satisfied by any CrudService). */
export interface RestorableService<T extends RestorableEntity> {
  findDeletedById(id: string, orgId?: string): Promise<T | null>;
  restore(id: string, orgId: string, userId: string): Promise<T | null>;
}

/** The slice of a service a purge route uses (satisfied by any CrudService). */
export interface PurgeableService<T extends RestorableEntity> {
  findDeletedById(id: string, orgId?: string): Promise<T | null>;
  purgeById(id: string, orgId?: string): Promise<string | null>;
}

/**
 * Decides whether the caller may restore/purge the loaded tombstone. Returns
 * false after it has ANSWERED the request (403). Load-bearing: the tombstone
 * load is org-scoped, not visibility-scoped, so this is what stops a colleague
 * resurrecting (or destroying) someone else's draft.
 */
export type TombstoneAuthorizer<T> = (existing: T, req: Request, res: Response) => boolean;

export type TombstoneRouteOptions<T extends RestorableEntity> = {
  orgId: string;
  userId: string;
  /** User-facing entity noun for the 400/404 messages ('Pipeline', 'Rule', …). */
  label: string;
  /**
   * The org the tombstone load and the mutation are pinned to. Defaults to
   * `orgId`; `undefined` spans orgs (system-admin moderation).
   */
  scopeOrgId?: string | undefined;
} & (
  /** Same authority as delete on the visibility ladder: `publishPermission`
   *  for a public row, authorship for a private one. */
  | { publishPermission: Permission; authorize?: undefined }
  | { authorize: TombstoneAuthorizer<T>; publishPermission?: undefined }
);

/** Shared prelude: `:id` → own-scope tombstone → authorization. `null` = answered. */
async function loadTombstone<T extends RestorableEntity>(
  req: Request,
  res: Response,
  service: { findDeletedById(id: string, orgId?: string): Promise<T | null> },
  opts: TombstoneRouteOptions<T>,
): Promise<{ id: string; existing: T; scope: string | undefined } | null> {
  const id = getParam(req.params, 'id');
  if (!id) {
    sendBadRequest(res, `${opts.label} ID is required.`, ErrorCode.MISSING_REQUIRED_FIELD);
    return null;
  }
  const scope = 'scopeOrgId' in opts ? opts.scopeOrgId : opts.orgId;

  // A live row / unknown id / already-purged → 404, so a currently-active entity
  // is never restored or hard-deleted through these paths.
  const existing = await service.findDeletedById(id, scope);
  if (!existing) {
    sendEntityNotFound(res, opts.label);
    return null;
  }

  const allowed = opts.authorize
    ? opts.authorize(existing, req, res)
    : requireVisibilityWriteAccess(req, res, existing, opts.userId, opts.publishPermission);
  if (!allowed) return null;
  return { id, existing, scope };
}

/**
 * Shared skeleton for a step-up-gated entity RESTORE route: extract `:id`, load
 * the tombstone, authorize it, restore, and 404 on miss. Returns
 * `{ existing, restored }` on success, or `null` when it has ALREADY sent a
 * response (400/404/403) — the caller then does the entity-specific audit +
 * response. Step-up is the route's job.
 */
export async function loadAndRestore<T extends RestorableEntity>(
  req: Request,
  res: Response,
  service: RestorableService<T>,
  opts: TombstoneRouteOptions<T>,
): Promise<{ existing: T; restored: T } | null> {
  const loaded = await loadTombstone(req, res, service, opts);
  if (!loaded) return null;

  const restored = await service.restore(loaded.id, loaded.scope ?? '', opts.userId);
  if (!restored) {
    sendEntityNotFound(res, opts.label);
    return null;
  }
  return { existing: loaded.existing, restored };
}

/**
 * Shared skeleton for an entity PURGE route: the same load + authorization as
 * restore, then a permanent hard-delete via the retention sweep's single-id
 * purge (same tombstone match + dependent-teardown hooks). Returns
 * `{ existing, purgedId }` (the caller audits off `existing`), or `null` when it
 * has ALREADY sent a response. Step-up is the route's job.
 */
export async function loadAndPurge<T extends RestorableEntity>(
  req: Request,
  res: Response,
  service: PurgeableService<T>,
  opts: TombstoneRouteOptions<T>,
): Promise<{ existing: T; purgedId: string } | null> {
  const loaded = await loadTombstone(req, res, service, opts);
  if (!loaded) return null;

  // Null on a race (already purged) → 404.
  const purgedId = await service.purgeById(loaded.id, loaded.scope ?? '');
  if (!purgedId) {
    sendEntityNotFound(res, opts.label);
    return null;
  }
  return { existing: loaded.existing, purgedId };
}
