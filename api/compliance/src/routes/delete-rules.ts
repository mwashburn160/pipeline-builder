// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendEntityNotFound, ErrorCode, getParam } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { complianceRuleService } from '../services/compliance-rule-service';

export function createDeleteRuleRoutes(): Router {
  const router = Router();

  router.delete('/:id', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Rule ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const deleted = await complianceRuleService.delete(id, orgId, userId);
    if (!deleted) return sendEntityNotFound(res, 'Rule');

    ctx.log('COMPLETED', 'Deleted compliance rule', { id, name: deleted.name });
    return sendSuccess(res, 200, undefined, 'Rule deleted');
  }));

  return router;
}
