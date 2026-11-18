// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Controllers for per-org alert rule authoring.
 *
 * GET /api/observability/alert-rules  list this org's rules (paginated)
 * GET /api/observability/alert-rules/deleted  this org's restorable tombstones
 * POST /api/observability/alert-rules  create (org-admin)
 * PUT /api/observability/alert-rules/:id  update (org-admin)
 * DELETE /api/observability/alert-rules/:id  delete (org-admin)
 * POST /api/observability/alert-rules/:id/restore  undo a delete (step-up)
 * POST /api/observability/alert-rules/:id/purge  permanent delete (step-up)
 * GET /api/observability/alert-rules/materialized.yml  Prom rule_files YAML (sysadmin / sidecar)
 *
 * The materialized endpoint returns the rendered YAML across all orgs and
 * is what Prometheus (via a config-reloader sidecar or a curl-based cron)
 * pulls to pick up operator-authored rules at runtime.
 */

import { createLogger, getParam, paginationMeta, sendError, sendSuccess, isSystemAdmin } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { requireAuthContext, requireOrgMembership, withController } from '../helpers/controller-helper.js';
import { listPage } from '../helpers/pagination.js';
import { releaseFeatureQuota, withFeatureQuota } from '../middleware/quota.js';
import { alertRuleService, prepareRuleExpr, renderRulesYaml, validateRule } from '../services/alert-rule-service.js';
import { PromQLRewriteError } from '../services/promql-rewriter.js';
import { createAlertRuleSchema, updateAlertRuleSchema } from '../utils/validation-observability.js';
import { validateBody } from '../utils/validation.js';

const logger = createLogger('alert-rules-controller');

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** GET /api/observability/alert-rules?offset=&limit=  one page of this org's
 *  rules (sorted by name), plus the pagination envelope the list pages share. */
export const listAlertRules = withController('List alert rules', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;

  const { offset, limit } = listPage(req.query);
  const { rules, total } = await alertRuleService.listForOrg(orgId, { offset, limit });
  sendSuccess(res, 200, {
    rules,
    pagination: paginationMeta({ total, offset, limit }),
  });
});

/** GET /api/observability/alert-rules/deleted  this org's restorable tombstones
 *  ("recently deleted"). Same `observability:read` gate + org scope as the live
 *  list — a tombstone is no more visible than the row it came from. */
export const listDeletedAlertRules = withController('List deleted alert rules', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;

  const rules = await alertRuleService.listDeletedForOrg(orgId);
  sendSuccess(res, 200, { rules });
});

/** POST /api/observability/alert-rules  create. Org-admin or above. */
export const createAlertRule = withController('Create alert rule', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;
  // Static `observability:write` gate now enforced at the route
  // (`requirePermission('observability:write')`), visible in the route table.

  const create = validateBody(createAlertRuleSchema, req.body, res);
  if (!create) return;

  // auto-inject the org_id matcher before validation. Operators can
  // write a vanilla PromQL expr and the service scopes it to their org;
  // any pre-existing `org_id="<theirs>"` is idempotent. A pre-existing
  // matcher targeting a DIFFERENT org throws via PromQLRewriteError.
  try {
    create.expr = prepareRuleExpr(create.expr, orgId);
  } catch (err) {
    if (err instanceof PromQLRewriteError) return sendError(res, 400, err.message);
    throw err;
  }
  const validation = validateRule(orgId, create);
  if (!validation.ok) return sendError(res, 400, validation.message);

  // Per-org cap on alert rules; reserve atomically before insert.
  await withFeatureQuota(res, orgId, 'alertRules', async () => {
    const rule = await alertRuleService.create(orgId, userId, create);

    audit(req, 'alert.rule.create', {
      targetType: 'alert-rule',
      targetId: rule.id,
      affectedOrgId: orgId,
      details: { name: rule.name, severity: rule.severity },
    });

    sendSuccess(res, 201, { rule });
  });
});

/** PUT /api/observability/alert-rules/:id  update. Org-admin or above. */
export const updateAlertRule = withController('Update alert rule', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;
  // Static `observability:write` gate now enforced at the route.

  const id = getParam(req.params, 'id')!;

  const patch = validateBody(updateAlertRuleSchema, req.body, res);
  if (!patch) return;
  if (patch.expr !== undefined) {
    try {
      patch.expr = prepareRuleExpr(patch.expr, orgId);
    } catch (err) {
      if (err instanceof PromQLRewriteError) return sendError(res, 400, err.message);
      throw err;
    }
  }
  const validation = validateRule(orgId, patch);
  if (!validation.ok) return sendError(res, 400, validation.message);

  const rule = await alertRuleService.update(orgId, id, userId, patch);
  if (!rule) return sendError(res, 404, 'Alert rule not found');

  audit(req, 'alert.rule.update', {
    targetType: 'alert-rule',
    targetId: rule.id,
    affectedOrgId: orgId,
  });

  sendSuccess(res, 200, { rule });
});

/** DELETE /api/observability/alert-rules/:id  soft-delete. Org-admin or above. */
export const deleteAlertRule = withController('Delete alert rule', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;
  // Static `observability:write` gate now enforced at the route.

  const id = getParam(req.params, 'id')!;

  const ok = await alertRuleService.delete(orgId, id, userId);
  if (!ok) return sendError(res, 404, 'Alert rule not found');

  releaseFeatureQuota(orgId, 'alertRules', logger.warn.bind(logger), null);

  audit(req, 'alert.rule.delete', {
    targetType: 'alert-rule',
    targetId: id,
    affectedOrgId: orgId,
  });

  sendSuccess(res, 200, {});
});

/** POST /api/observability/alert-rules/:id/restore — undo a soft-delete within
 *  the retention window. Same `observability:write` gate as delete, plus step-up.
 *  A restored enabled rule re-enters the materializer on its next poll. */
export const restoreAlertRule = withController('Restore alert rule', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;

  const id = getParam(req.params, 'id')!;

  // Restore re-adds a live row → re-reserve the feature slot delete released.
  await withFeatureQuota(res, orgId, 'alertRules', async () => {
    try {
      const ok = await alertRuleService.restore(orgId, id, userId);
      if (!ok) {
        sendError(res, 404, 'Alert rule not found');
        return false;
      }
    } catch (err) {
      // (org_id, name) unique index is partial (WHERE deleted_at IS NULL) — a live
      // namesake can coexist with this tombstone, so restore can collide → 409.
      if ((err as { code?: string }).code === '23505') {
        sendError(res, 409, 'An alert rule with this name already exists — rename it and try again.');
        return false;
      }
      throw err;
    }
    audit(req, 'alert.rule.restore', {
      targetType: 'alert-rule',
      targetId: id,
      affectedOrgId: orgId,
    });
    sendSuccess(res, 200, {});
    return true;
  });
});

/**
 * POST /api/observability/alert-rules/:id/purge — PERMANENT hard-delete of a
 * tombstone, finalizing now what the retention sweep would do at `purge_after`.
 * Same `observability:write` + step-up gate as restore (irreversible), org-scoped
 * in the service. 404 when the id is unknown or still live — a live rule must be
 * soft-deleted first.
 *
 * No quota release: delete already released the `alertRules` slot, and the
 * tombstone never held one.
 */
export const purgeAlertRule = withController('Purge alert rule', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { orgId } = ctx;

  const id = getParam(req.params, 'id')!;

  // Load the tombstone first: gates on own-org scope + genuine soft-delete, and
  // captures the name for the audit record before the row is destroyed.
  const existing = await alertRuleService.findDeletedById(orgId, id);
  if (!existing) return sendError(res, 404, 'Alert rule not found');

  const ok = await alertRuleService.purgeById(orgId, id);
  if (!ok) return sendError(res, 404, 'Alert rule not found');

  audit(req, 'alert.rule.purge', {
    targetType: 'alert-rule',
    targetId: id,
    affectedOrgId: orgId,
    details: { name: existing.name },
  });

  sendSuccess(res, 200, {}, 'Alert rule permanently deleted');
});

// ---------------------------------------------------------------------------
// Materializer
// ---------------------------------------------------------------------------

/**
 * GET /api/observability/alert-rules/materialized.yml  render every enabled
 * rule across all orgs into a Prometheus rule_files YAML document.
 *
 * Access: sysadmin only by default. A config-reloader sidecar pulls this
 * with a service token; operator may also `curl` it for debugging. The
 * endpoint runs a cross-org scan under sysadmin tenant context (service
 * code, not user code) so RLS doesn't filter to a single org.
 */
export const materializeAlertRules = withController('Materialize alert rules', async (req, res) => {
  if (!isSystemAdmin(req)) {
    return sendError(res, 403, 'System admin required to fetch materialized rules');
  }
  const rules = await alertRuleService.listAllEnabledForMaterializer();
  const yaml = renderRulesYaml(rules);
  logger.debug('Materialized alert rules', { count: rules.length, bytes: yaml.length });
  res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
  res.status(200).send(yaml);
});
