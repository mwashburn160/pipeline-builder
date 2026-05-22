// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import AuditEvent, { type AuditAction, type AuditEventDocument } from '../models/audit-event';

const logger = createLogger('audit-service');

export interface AuditFilter {
  /** Actor's org at action-time. */
  orgId?: string;
  /** Org operated ON. Differs from `orgId` for cross-tenant sysadmin actions
   *  (sysadmin acting on org X). Filtering on this answers "what was done
   *  to org X" regardless of which actor performed it. */
  affectedOrgId?: string;
  /** Specific user who performed the action. */
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
}

export interface AuditCreateInput {
  action: AuditAction;
  actorId: string;
  actorEmail?: string;
  orgId?: string;
  /** Org being operated on (cross-tenant sysadmin actions). Falls back to
   *  `orgId` when omitted, matching how the audit helper auto-populates it. */
  affectedOrgId?: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}

export interface PaginatedAuditResult {
  events: AuditEventDocument[];
  pagination: { total: number; offset: number; limit: number; hasMore: boolean };
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
    offset: number,
    limit: number,
  ): Promise<PaginatedAuditResult> {
    const query: Record<string, unknown> = {};

    if (filter.orgId) query.orgId = filter.orgId;
    if (filter.affectedOrgId) query.affectedOrgId = filter.affectedOrgId;
    if (filter.actorId) query.actorId = filter.actorId;
    if (filter.action) {
      const escaped = filter.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.action = { $regex: escaped, $options: 'i' };
    }
    if (filter.targetType) query.targetType = filter.targetType;
    if (filter.targetId) query.targetId = filter.targetId;

    const [events, total] = await Promise.all([
      AuditEvent.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      AuditEvent.countDocuments(query),
    ]);

    return {
      events: events as AuditEventDocument[],
      pagination: { total, offset, limit, hasMore: offset + limit < total },
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
