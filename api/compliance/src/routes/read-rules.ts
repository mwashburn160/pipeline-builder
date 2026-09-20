// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendPaginatedNested, sendEntityNotFound, getParam, parsePaginationParams, requirePermission } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { withInheritedSource } from '../helpers/inherited-source.js';
import { complianceRuleService } from '../services/compliance-rule-service.js';

/**
 * Rule reads require `compliance:read` (in the member bundle). Gated PER ROUTE:
 * the composite `/compliance/rules` router mounts these reads ahead of its
 * `compliance:write` gate, so a `router.use(...)` here would also run for the
 * mutation routers mounted after it.
 */
const requireComplianceRead = requirePermission('compliance:read');

export function createReadRuleRoutes(): Router {
  const router = Router();

  // GET / — list rules with pagination and filters
  router.get('/', requireComplianceRead, withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(req.query);
    const filter = {
      name: req.query.name as string | undefined,
      policyId: req.query.policyId as string | undefined,
      target: req.query.target as 'plugin' | 'pipeline' | undefined,
      severity: req.query.severity as 'warning' | 'error' | 'critical' | undefined,
      scope: req.query.scope as 'org' | 'published' | undefined,
      tag: req.query.tag as string | undefined,
    };

    // A team also SEES its parent's `propagateToChildren` rules here, exactly as
    // `/enforced` and upload-time validation do — they bind the team, so hiding
    // them from the rule list made a failing build unexplainable. They come back
    // labelled with their source org (name, not id) and are read-only: the
    // update/delete routes refuse a team's attempt with a 403.
    const parentOrgId = (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;
    const result = await complianceRuleService.findPaginated(
      filter, orgId, { limit, offset, sortBy: sortBy || 'priority', sortOrder: sortOrder || 'desc' }, parentOrgId,
    );
    const rules = await withInheritedSource(result.data, parentOrgId);

    ctx.log('COMPLETED', 'Listed compliance rules', { count: rules.length });
    return sendPaginatedNested(res, 'rules', rules, {
      total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore,
    });
  }));

  // GET /deleted — org's soft-deleted rule tombstones (most recent first),
  // powering the "recently deleted" restore UI. Registered BEFORE `/:id` so the
  // literal path isn't swallowed by the id matcher.
  router.get('/deleted', requireComplianceRead, withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query);
    const deleted = await complianceRuleService.findDeleted(orgId, { limit, offset });

    ctx.log('COMPLETED', 'Listed deleted compliance rules', { count: deleted.length });
    return sendSuccess(res, 200, { rules: deleted });
  }));

  // GET /:id — single rule by ID
  router.get('/:id', requireComplianceRead, withRoute(async ({ req, res, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendEntityNotFound(res, 'Rule');

    const rule = await complianceRuleService.findById(id, orgId);
    if (!rule) return sendEntityNotFound(res, 'Rule');

    return sendSuccess(res, 200, { rule });
  }));

  // GET /:id/history — rule change history (org-scoped, paginated)
  router.get('/:id/history', requireComplianceRead, withRoute(async ({ req, res, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendEntityNotFound(res, 'Rule');

    const { limit, offset } = parsePaginationParams(req.query);
    const { history, total } = await complianceRuleService.findRuleHistory(id, orgId, { limit, offset });

    return sendPaginatedNested(res, 'history', history, {
      total, limit, offset, hasMore: offset + history.length < total,
    });
  }));

  return router;
}
