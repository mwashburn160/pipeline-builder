// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isSystemAdmin, sendError } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';

/**
 * The tenant an internal service-token request acts for.
 *
 * `requireServiceAuth` only proves the caller is SOME service; the token's own
 * `organizationId` is the authoritative tenant. So:
 *   - a sysadmin/system service token (`isSuperAdmin`) may name any org — the
 *     body's `orgId`, else its own;
 *   - any other service token acts for ITS org only: a body `orgId` naming a
 *     different org is refused, and an org-less token is refused outright (fail
 *     closed — otherwise the tenant falls back to the caller-controlled body).
 *
 * Returns the effective org id (undefined only for a sysadmin token with no org
 * anywhere), or `null` after sending the 403.
 */
export function resolveServiceTenant(req: Request, res: Response, bodyOrgId: string | undefined): string | undefined | null {
  const tokenOrgId = req.user?.organizationId;
  if (isSystemAdmin(req)) return bodyOrgId ?? tokenOrgId;
  if (!tokenOrgId) {
    sendError(res, 403, 'service token has no org claim');
    return null;
  }
  if (bodyOrgId && bodyOrgId !== tokenOrgId) {
    sendError(res, 403, 'orgId does not match authenticated service org');
    return null;
  }
  return tokenOrgId;
}
