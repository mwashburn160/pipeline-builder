// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireStepUp` middleware — enforces a recent password reverify before
 * destructive endpoints.
 *
 * The flow:
 *   1. UI prompts for password and POSTs /api/auth/step-up.
 *   2. Backend issues a short-lived `stepUpToken` JWT (60s default).
 *   3. UI sends that token as the `X-Step-Up-Token` header on the next
 *      destructive request.
 *   4. This middleware verifies signature + expiry + that `sub` matches
 *      `req.user.sub`, then lets the handler run.
 *
 * Single-use is enforced via the jti consumption store (see `consumed-jti.ts`),
 * which is backed by the shared env Redis when configured (single-use across
 * replicas) and degrades to a process-local Map otherwise.
 */

import { sendError } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';
import { consumeJti } from './consumed-jti.js';
import { verifyStepUpToken } from '../utils/token.js';

const HEADER = 'x-step-up-token';

export async function requireStepUp(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.user?.sub;
  if (!userId) {
    sendError(res, 401, 'Authentication required');
    return;
  }

  const token = req.header(HEADER);
  if (!token) {
    sendError(res, 401, 'Step-up confirmation required', 'STEP_UP_REQUIRED');
    return;
  }

  try {
    const payload = verifyStepUpToken(token);
    if (payload.sub !== userId) {
      // Token issued to a different user — possibly a session swap; reject hard.
      sendError(res, 401, 'Step-up token does not match session', 'STEP_UP_MISMATCH');
      return;
    }
    // Single-use enforcement: reject replays within the token's TTL.
    // We do this AFTER the sub check so a replay attempt against a
    // different user still reports MISMATCH (the more informative error).
    if (!(await consumeJti(payload.jti, payload.exp))) {
      sendError(res, 401, 'Step-up token already used or expired', 'STEP_UP_REPLAY');
      return;
    }
    next();
  } catch {
    // Single error path covers expired + bad signature + malformed. The
    // frontend reacts the same way (re-prompt for password) so distinguishing
    // them only helps an attacker probe.
    sendError(res, 401, 'Step-up token invalid or expired', 'STEP_UP_INVALID');
  }
}
