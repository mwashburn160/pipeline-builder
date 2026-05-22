// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Blocks state-changing requests when the caller is operating under a
 * read-only impersonation token. Lets a sysadmin "view as user X" for
 * support work without any chance of destructive actions landing under
 * that identity.
 *
 * Whitelisted methods: GET, HEAD, OPTIONS.
 *
 * Applied globally after `requireAuth` populates `req.user`. Endpoints
 * that legitimately need a state change while impersonated (none
 * today) would have to opt out individually.
 */

import { sendError } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireWriteAccess(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.impersonationReadOnly === true && !READ_METHODS.has(req.method)) {
    sendError(
      res, 403,
      'Write requests are disabled during read-only impersonation. Stop impersonating to make changes.',
      'IMPERSONATION_READ_ONLY',
    );
    return;
  }
  next();
}
