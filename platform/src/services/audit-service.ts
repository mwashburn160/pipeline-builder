import { createLogger } from '@mwashburn160/api-core';
import AuditEvent, { type AuditAction, type AuditEventDocument } from '../models/audit-event';

const logger = createLogger('audit-service');

export interface AuditFilter {
  orgId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
}

export interface AuditCreateInput {
  action: AuditAction;
  actorId: string;
  actorEmail?: string;
  orgId?: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}

export interface PaginatedAuditResult {
  events: AuditEventDocument[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Service layer for audit events — replaces inline Mongoose queries in routes.
 */
class AuditService {
  /**
   * Find audit events with filtering and pagination.
   */
  async findEvents(
    filter: AuditFilter,
    page: number,
    limit: number,
  ): Promise<PaginatedAuditResult> {
    const query: Record<string, unknown> = {};

    if (filter.orgId) query.orgId = filter.orgId;
    if (filter.action) query.action = { $regex: filter.action, $options: 'i' };
    if (filter.targetType) query.targetType = filter.targetType;
    if (filter.targetId) query.targetId = filter.targetId;

    const skip = (page - 1) * limit;

    const [events, total] = await Promise.all([
      AuditEvent.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuditEvent.countDocuments(query),
    ]);

    return {
      events: events as AuditEventDocument[],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Create a new audit event.
   */
  async createEvent(input: AuditCreateInput): Promise<AuditEventDocument> {
    const event = await AuditEvent.create(input);
    return event;
  }

  /**
   * Create an audit event without blocking the caller (fire-and-forget).
   */
  createEventAsync(input: AuditCreateInput): void {
    AuditEvent.create(input).catch((err) => {
      logger.warn('Failed to create audit event', { error: String(err), action: input.action });
    });
  }
}

export const auditService = new AuditService();
