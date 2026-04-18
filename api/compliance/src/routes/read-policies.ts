// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendEntityNotFound, getParam, parsePaginationParams } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { compliancePolicyService } from '../services/policy-service';

export function createReadPolicyRoutes(): Router {
  const router = Router();

  // GET / — list policies with pagination and filters
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(req.query);
    const filter = {
      name: req.query.name as string | undefined,
      isTemplate: req.query.isTemplate === 'true' ? true : req.query.isTemplate === 'false' ? false : undefined,
    };

    const result = await compliancePolicyService.findPaginated(
      filter, orgId, { limit, offset, sortBy: sortBy || 'name', sortOrder: sortOrder || 'asc' },
    );

    ctx.log('COMPLETED', 'Listed compliance policies', { count: result.data.length });
    return sendSuccess(res, 200, {
      policies: result.data,
      pagination: { total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore },
    });
  }));

  // GET /:id — single policy by ID
  router.get('/:id', withRoute(async ({ req, res, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendEntityNotFound(res, 'Policy');

    const policy = await compliancePolicyService.findById(id, orgId);
    if (!policy) return sendEntityNotFound(res, 'Policy');

    return sendSuccess(res, 200, { policy });
  }));

  return router;
}
