// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendError, ErrorCode } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { complianceRuleService } from '../services/compliance-rule-service.js';

/** Message returned when a team tries to mutate a rule its parent propagates. */
export const INHERITED_RULE_MESSAGE =
  'This rule is inherited from the parent organization and is read-only here. Edit or delete it in the parent organization.';

/**
 * For a rule mutation that found no rule in the caller's own org: when the
 * caller is a team and the id is a rule its parent propagates to it, answer
 * 403 with a clear reason (instead of a bare not-found) and return true.
 * Returns false (caller sends its usual 404) otherwise. Only runs on the
 * not-found path, so owned-rule edits pay nothing.
 */
export async function rejectIfInheritedRule(req: Request, res: Response, id: string): Promise<boolean> {
  const parentOrgId = (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;
  if (!parentOrgId) return false;
  if (!(await complianceRuleService.isInheritedRule(id, parentOrgId))) return false;
  sendError(res, 403, INHERITED_RULE_MESSAGE, ErrorCode.INSUFFICIENT_PERMISSIONS);
  return true;
}
