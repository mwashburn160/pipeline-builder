// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The cascade outbox, for operators (services/cascade-outbox.ts):
 *
 *   GET  /admin/cascade                 — list legs (?status, kind, subjectId, service; paged)
 *   POST /admin/cascade/:id/redrive     — put a dead / stuck pending leg back in the queue
 *
 * Both are system-org surfaces; each controller re-checks the permission its
 * route gates on, so a direct controller call cannot bypass the gate. The
 * redrive is the runbook step for `PlatformCascadeLegDead`: fix the owning
 * service, then redrive its dead legs — every leg's handler is idempotent.
 */

import { ErrorCode, getParam, parsePage, parseQueryString, sendError, sendPaginatedNested, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { requirePlatformPermission, withController } from '../helpers/controller-helper.js';
import { CASCADE_KINDS, CASCADE_LEG_STATUSES, type CascadeKind, type CascadeLegStatus } from '../models/cascade-outbox.js';
import { listCascadeLegs, redriveCascadeLeg } from '../services/cascade-outbox.js';
import { cascadeRedriveSchema, validateBody } from '../utils/validation.js';

/** Bounded like every free-text filter: ids and service names are short. */
const FILTER_MAX = 128;

/** GET /admin/cascade */
export const listCascade = withController('List cascade outbox', async (req, res) => {
  if (!requirePlatformPermission(req, res, 'platform:read')) return;
  const status = parseQueryString(req.query.status);
  if (status !== undefined && !(CASCADE_LEG_STATUSES as readonly string[]).includes(status)) {
    return sendError(res, 400, `status must be one of ${CASCADE_LEG_STATUSES.join(', ')}`, ErrorCode.VALIDATION_ERROR);
  }
  const kind = parseQueryString(req.query.kind);
  if (kind !== undefined && !(CASCADE_KINDS as readonly string[]).includes(kind)) {
    return sendError(res, 400, `kind must be one of ${CASCADE_KINDS.join(', ')}`, ErrorCode.VALIDATION_ERROR);
  }
  const subjectId = parseQueryString(req.query.subjectId);
  const service = parseQueryString(req.query.service);
  if ((subjectId?.length ?? 0) > FILTER_MAX || (service?.length ?? 0) > FILTER_MAX) {
    return sendError(res, 400, `subjectId and service are at most ${FILTER_MAX} characters`, ErrorCode.VALIDATION_ERROR);
  }
  const { limit, offset } = parsePage(req.query as Record<string, unknown>, { def: 50, max: 200 });
  const { legs, total } = await listCascadeLegs(
    {
      ...(status ? { status: status as CascadeLegStatus } : {}),
      ...(kind ? { kind: kind as CascadeKind } : {}),
      ...(subjectId ? { subjectId } : {}),
      ...(service ? { service } : {}),
    },
    { limit, offset },
  );
  sendPaginatedNested(res, 'legs', legs, { total, limit, offset });
});

/** POST /admin/cascade/:id/redrive — body `{ resetAttempts?: boolean (default true), reason?: string }`. */
export const redriveCascade = withController('Redrive cascade leg', async (req, res) => {
  if (!requirePlatformPermission(req, res, 'orgs:manage')) return;
  const body = validateBody(cascadeRedriveSchema, req.body ?? {}, res);
  if (!body) return;
  const id = getParam(req.params, 'id')!;

  const result = await redriveCascadeLeg(id, { resetAttempts: body.resetAttempts });
  if (!result.ok) {
    return result.reason === 'already_done'
      ? sendError(res, 409, 'This cascade leg was already delivered — there is nothing to redrive', ErrorCode.CONFLICT)
      : sendError(res, 404, 'Cascade leg not found', ErrorCode.NOT_FOUND);
  }
  const { leg, previous } = result;
  const isOrg = leg.kind === 'org.deleted';
  audit(req, 'admin.cascade.redrive', {
    targetType: isOrg ? 'organization' : 'user',
    targetId: leg.subjectId,
    ...(isOrg ? { affectedOrgId: leg.subjectId } : {}),
    details: {
      legId: leg.id,
      kind: leg.kind,
      service: leg.service,
      previousStatus: previous.status,
      previousAttempts: previous.attempts,
      resetAttempts: body.resetAttempts !== false,
      ...(body.reason ? { reason: body.reason } : {}),
    },
  });
  sendSuccess(res, 200, { leg }, `Cascade leg to ${leg.service} queued for redelivery`);
});
