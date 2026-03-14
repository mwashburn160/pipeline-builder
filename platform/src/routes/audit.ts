import { sendError, sendSuccess, createLogger } from '@mwashburn160/api-core';
import { Router, Request, Response } from 'express';
import { requireAdminContext } from '../helpers/controller-helper';
import { requireAuth } from '../middleware';
import AuditEvent from '../models/audit-event';
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
    const { action, targetType, targetId, page, limit } = req.query;
    const { page: pageNum, limit: limitNum, skip } = parsePagination(page, limit);

    const filter: Record<string, unknown> = {};

    // Org admins can only see their org's events
    if (admin.isOrgAdmin) {
      filter.orgId = req.user!.organizationId;
    } else if (req.query.orgId) {
      filter.orgId = req.query.orgId;
    }

    if (action) filter.action = { $regex: action, $options: 'i' };
    if (targetType) filter.targetType = targetType;
    if (targetId) filter.targetId = targetId;

    const [events, total] = await Promise.all([
      AuditEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      AuditEvent.countDocuments(filter),
    ]);

    sendSuccess(res, 200, {
      events,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    logger.error('[AUDIT] List error', error);
    sendError(res, 500, 'Failed to list audit events');
  }
});

export default router;
