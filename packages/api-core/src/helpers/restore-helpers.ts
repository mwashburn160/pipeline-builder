// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Request, Response } from 'express';
import { ErrorCode } from '../types/error-codes.js';
import type { Permission } from '../types/permissions.js';
import { getParam } from '../utils/params.js';
import { sendBadRequest } from '../utils/response.js';
import { requirePublicAccess } from './access-helpers.js';
import { sendEntityNotFound } from './crud-helpers.js';

/** Minimal shape a restore route needs from the entity it restores. */
export interface RestorableEntity {
  orgId: string;
  accessModifier?: string;
}

/** The slice of a service a restore route uses (satisfied by any CrudService). */
export interface RestorableService<T extends RestorableEntity> {
  findDeletedById(id: string, orgId?: string): Promise<T | null>;
  restore(id: string, orgId: string, userId: string): Promise<T | null>;
}

/**
 * Shared skeleton for a step-up-gated entity restore route: extract `:id`, load
 * the own-org tombstone, gate a PUBLIC entity on `publishPermission` (parity with
 * delete), restore, and 404 on miss. Returns `{ existing, restored }` on success,
 * or `null` when it has ALREADY sent a response (400/404/403) — the caller then
 * does the entity-specific audit + response. DRYs the near-identical
 * pipeline / plugin / pipeline_template restore routes (which differ only in
 * service, audit action, and response shaping).
 */
export async function loadAndRestore<T extends RestorableEntity>(
  req: Request,
  res: Response,
  orgId: string,
  userId: string,
  service: RestorableService<T>,
  label: string,
  publishPermission: Permission,
): Promise<{ existing: T; restored: T } | null> {
  const id = getParam(req.params, 'id');
  if (!id) {
    sendBadRequest(res, `${label} ID is required.`, ErrorCode.MISSING_REQUIRED_FIELD);
    return null;
  }

  // Load the TOMBSTONE (own-org). A live row / unknown id / already-purged → 404.
  const existing = await service.findDeletedById(id, orgId);
  if (!existing) {
    sendEntityNotFound(res, label);
    return null;
  }

  // Public (shared) entities: same publish gate as delete.
  if (!requirePublicAccess(req, res, existing, publishPermission)) return null;

  const restored = await service.restore(id, orgId, userId || 'system');
  if (!restored) {
    sendEntityNotFound(res, label);
    return null;
  }

  return { existing, restored };
}
