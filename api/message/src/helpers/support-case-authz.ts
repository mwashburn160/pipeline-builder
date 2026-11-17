// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, sendError } from '@pipeline-builder/api-core';
import type { Response } from 'express';

/**
 * The two people on the TENANT side who may act on a support case: its AUTHOR
 * (who raised it) and its current `tenant_contact` (who owns it now).
 *
 * The tenant-side case routes run on `messages:read`, and org-wide read means
 * ANY reader in the case's org passes the own-org check — acting on a case is a
 * narrower right than reading one. The second person is not optional: tenant
 * reassignment exists so a case can change hands when its opener goes on leave,
 * and if the new owner cannot act on it the reassignment is cosmetic.
 *
 * Deliberately NOT "any designated contact": that needs the cross-service
 * entitlement read on every call, for an answer already on rows this service
 * holds.
 */
export interface CaseParticipants {
  createdBy?: string | null;
  tenantContact?: string | null;
}

export const CASE_PARTICIPANT_REFUSAL =
  'Only the person who raised this case, or the contact it is assigned to, can act on it';

/** Whether `userId` is the case's author or its current tenant contact. */
export function isCaseParticipant(c: CaseParticipants, userId: string): boolean {
  return (!!c.createdBy && c.createdBy === userId) || (!!c.tenantContact && c.tenantContact === userId);
}

/**
 * Answer 403 and return false unless `userId` is the case's author or current
 * tenant contact. Callers that admit support staff decide that BEFORE calling —
 * this is the tenant-side check only.
 */
export function authorizeCaseParticipant(
  res: Response,
  c: CaseParticipants,
  userId: string,
  message: string = CASE_PARTICIPANT_REFUSAL,
): boolean {
  if (isCaseParticipant(c, userId)) return true;
  sendError(res, 403, message, ErrorCode.INSUFFICIENT_PERMISSIONS);
  return false;
}
