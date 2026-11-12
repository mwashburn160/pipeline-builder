// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, isSystemAdmin, sendError } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';

/**
 * Why a non-admin may NOT delete / restore / purge this message, or null when
 * they may: only the sender acting on their OWN ROOT message. The predicate
 * half of {@link authorizeOwnRootMessage}, for callers (the bulk delete) that
 * collect refusals per row instead of answering the request.
 */
export function ownRootMessageRefusal(
  message: { createdBy?: string | null; threadId?: string | null },
  userId: string,
  verb: 'delete' | 'restore' | 'purge',
): string | null {
  if (message.createdBy !== userId) return `Only admins or the message sender can ${verb} messages`;
  if (message.threadId) {
    return `Only root messages can be ${verb === 'delete' ? 'deleted' : verb === 'restore' ? 'restored' : 'purged'} by non-admins`;
  }
  return null;
}

/**
 * Who may delete, restore or purge a message: a system admin (cross-org
 * moderation), or the sender acting on their OWN ROOT message. Answers 403 and
 * returns false otherwise.
 */
export function authorizeOwnRootMessage(
  req: Request,
  res: Response,
  message: { createdBy?: string | null; threadId?: string | null },
  userId: string,
  verb: 'delete' | 'restore' | 'purge',
): boolean {
  if (isSystemAdmin(req)) return true;
  const refusal = ownRootMessageRefusal(message, userId, verb);
  if (refusal) {
    sendError(res, 403, refusal, ErrorCode.INSUFFICIENT_PERMISSIONS);
    return false;
  }
  return true;
}
