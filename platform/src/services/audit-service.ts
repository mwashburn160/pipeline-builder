// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { paginationMeta, type PaginationMeta } from '@pipeline-builder/api-core';
import { appendAuditEvent } from '../helpers/audit-chain.js';
import AuditEvent, { type AuditEventData, type StoredAuditEvent } from '../models/audit-event.js';
import { escapeRegex } from '../utils/regex.js';

export interface AuditFilter {
  /** Actor's org at action-time. */
  orgId?: string;
  /** Org operated ON. Differs from `orgId` for cross-tenant sysadmin actions
   *  (sysadmin acting on org X). Filtering on this answers "what was done
   *  to org X" regardless of which actor performed it. */
  affectedOrgId?: string;
  /**
   * Match events where EITHER `orgId` OR `affectedOrgId` equals this value.
   * Use for org admins reading their own org's audit: they should see
   * events their org acted (orgId) AND events another org acted on them
   * (affectedOrgId). When set, `orgId`/`affectedOrgId` filters above are
   * ignored to keep the predicate single-shaped.
   */
  orgIdOrAffected?: string;
  /** Specific user who performed the action. */
  actorId?: string;
  /** Case-insensitive substring match on the action. */
  action?: string;
  /**
   * Action GROUP: an event matches when its action matches ANY entry — `foo.`
   * is a prefix, anything else an exact action (both anchored, so a match in
   * the middle of an unrelated action never counts). ANDed with `action`.
   */
  actions?: string[];
  targetType?: string;
  targetId?: string;
  /** Permission role involved (org.role.* actions). */
  roleId?: string;
  /** Sysadmin behind an impersonated action — "what was done under
   *  impersonation by X". */
  impersonatorId?: string;
  /** Filter by outcome (success/failure) — e.g. surface only failed logins. */
  outcome?: 'success' | 'failure';
  /** Correlation id — pull every audited action from one HTTP request. */
  requestId?: string;
  /** Inclusive lower bound on the event's ingest `createdAt` timestamp
   *  (read-time range filter). Either bound may be set independently. */
  createdFrom?: Date;
  /** Inclusive upper bound on the event's ingest `createdAt` timestamp. */
  createdTo?: Date;
}

/**
 * What a caller supplies when appending an event: every field of a stored
 * {@link AuditEventData} except the ones the append path OWNS — the ingest
 * timestamp and the three tamper-evidence fields (`hash`, `seq`, `prevHash`),
 * which are computed from the chain head and must never come from a caller.
 *
 * DERIVED, not restated, so a new field on the model is accepted here the day
 * it is added; a hand-copied list silently dropped fields on their way in.
 */
export type AuditCreateInput = Omit<AuditEventData, 'createdAt' | 'hash' | 'seq' | 'prevHash'>;

export interface PaginatedAuditResult {
  events: StoredAuditEvent[];
  pagination: PaginationMeta;
}

/**
 * Translate an {@link AuditFilter} into a Mongo query. Shared by the paginated
 * list (`GET /audit`) and the Audit Activity dashboard panels
 * (`observability/audit-store-client.ts`) so both surfaces apply the SAME
 * org-scoping predicate — an org admin's dashboard can never see a row their
 * audit log wouldn't.
 */
export function buildAuditQuery(filter: AuditFilter): Record<string, unknown> {
  const query: Record<string, unknown> = {};

  if (filter.orgIdOrAffected) {
    // Org-admin reads need union: events actor=their-org OR target=their-org.
    query.$or = [
      { orgId: filter.orgIdOrAffected },
      { affectedOrgId: filter.orgIdOrAffected },
    ];
  } else {
    if (filter.orgId) query.orgId = filter.orgId;
    if (filter.affectedOrgId) query.affectedOrgId = filter.affectedOrgId;
  }
  if (filter.actorId) query.actorId = filter.actorId;
  const actionPredicates: Record<string, unknown>[] = [];
  if (filter.action) {
    actionPredicates.push({ action: { $regex: escapeRegex(filter.action), $options: 'i' } });
  }
  if (filter.actions && filter.actions.length > 0) {
    actionPredicates.push({
      action: {
        $in: filter.actions.map((a) => (a.endsWith('.') ? new RegExp(`^${escapeRegex(a)}`) : new RegExp(`^${escapeRegex(a)}$`))),
      },
    });
  }
  if (actionPredicates.length === 1) Object.assign(query, actionPredicates[0]);
  else if (actionPredicates.length > 1) query.$and = actionPredicates;
  if (filter.targetType) query.targetType = filter.targetType;
  if (filter.targetId) query.targetId = filter.targetId;
  if (filter.roleId) query.roleId = filter.roleId;
  if (filter.impersonatorId) query.impersonatorId = filter.impersonatorId;
  if (filter.outcome) query.outcome = filter.outcome;
  if (filter.requestId) query.requestId = filter.requestId;
  // Read-time createdAt range predicate. `createdAt` is the ingest timestamp
  // (mongoose `timestamps`) and the chain-ordering field — filtering on it
  // never touches audit record semantics or the hash chain. Either bound may
  // be present independently.
  if (filter.createdFrom || filter.createdTo) {
    const range: Record<string, Date> = {};
    if (filter.createdFrom) range.$gte = filter.createdFrom;
    if (filter.createdTo) range.$lte = filter.createdTo;
    query.createdAt = range;
  }
  return query;
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
    const query = buildAuditQuery(filter);

    const [events, total] = await Promise.all([
      AuditEvent.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      AuditEvent.countDocuments(query),
    ]);

    return {
      events,
      pagination: paginationMeta({ total, offset, limit }),
    };
  }

  /**
   * Create a new audit event. For fire-and-forget writes from request
   * handlers, prefer the `audit()` helper in `helpers/audit.ts` — it
   * also auto-populates `affectedOrgId` from the Express request.
   *
   * Delegates to the shared {@link appendAuditEvent} so EVERY event created
   * through the service (the `POST /audit/events` ingest, the `authz.denied`
   * sink, bootstrap super-admin grants) is tamper-evidence hash-chained via the
   * same single write path as the `audit()` helper.
   */
  async createEvent(input: AuditCreateInput): Promise<StoredAuditEvent> {
    return appendAuditEvent(input);
  }
}

export const auditService = new AuditService();
