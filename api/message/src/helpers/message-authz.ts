// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, isSystemAdmin, sendError } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';

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
  if (message.createdBy !== userId) {
    sendError(res, 403, `Only admins or the message sender can ${verb} messages`, ErrorCode.INSUFFICIENT_PERMISSIONS);
    return false;
  }
  if (message.threadId) {
    sendError(res, 403, `Only root messages can be ${verb === 'delete' ? 'deleted' : verb === 'restore' ? 'restored' : 'purged'} by non-admins`, ErrorCode.INSUFFICIENT_PERMISSIONS);
    return false;
  }
  return true;
}
