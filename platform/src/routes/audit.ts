import { sendError, sendSuccess, createLogger } from '@mwashburn160/api-core';
import { Router, Request, Response } from 'express';
import { requireAdminContext } from '../helpers/controller-helper';
import { requireAuth } from '../middleware';
import { auditService, type AuditFilter } from '../services/audit-service';
import { parsePagination } from '../utils/pagination';

const logger = createLogger('audit-routes');
const router = Router();

/**
 * GET /audit - List audit events (admin only, org-scoped for org admins)
 * Query: action, targetType, targetId, page, limit
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  try {
    const { action, targetType, targetId } = req.query;
    const { offset, limit: limitNum } = parsePagination(req.query.offset, req.query.limit);

    const filter: AuditFilter = {};

    // Org admins can only see their org's events
    if (admin.isOrgAdmin) {
      filter.orgId = req.user!.organizationId;
    } else if (req.query.orgId) {
      filter.orgId = req.query.orgId as string;
    }

    if (action) filter.action = action as string;
    if (targetType) filter.targetType = targetType as string;
    if (targetId) filter.targetId = targetId as string;

    const result = await auditService.findEvents(filter, offset, limitNum);

    sendSuccess(res, 200, result);
  } catch (error) {
    logger.error('[AUDIT] List error', error);
    sendError(res, 500, 'Failed to list audit events');
  }
});

export default router;
