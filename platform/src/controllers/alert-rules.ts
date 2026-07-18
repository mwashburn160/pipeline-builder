// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Controllers for per-org alert rule authoring.
 *
 * GET /api/observability/alert-rules  list this org's rules
 * POST /api/observability/alert-rules  create (org-admin)
 * PUT /api/observability/alert-rules/:id  update (org-admin)
 * DELETE /api/observability/alert-rules/:id  delete (org-admin)
 * GET /api/observability/alert-rules/materialized.yml  Prom rule_files YAML (sysadmin / sidecar)
 *
 * The materialized endpoint returns the rendered YAML across all orgs and
 * is what Prometheus (via a config-reloader sidecar or a curl-based cron)
 * pulls to pick up operator-authored rules at runtime.
 */

import { createLogger, getParam, sendError, sendQuotaExceeded, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { isSystemAdmin, requireAuthContext, requireOrgMembership, withController } from '../helpers/controller-helper.js';
import { releaseFeatureQuota, reserveFeatureQuota } from '../middleware/quota.js';
import { alertRuleService, prepareRuleExpr, renderRulesYaml, validateRule, type RuleCreate, type RuleUpdate } from '../services/alert-rule-service.js';
import { PromQLRewriteError } from '../services/promql-rewriter.js';

const logger = createLogger('alert-rules-controller');

/** Validate / coerce the POST/PUT body into a `RuleCreate` / `RuleUpdate`.
 *  The `op` argument disambiguates the two cases explicitly rather than
 *  inferring shape from "did the caller include name+expr+summary?" — the
 *  inference was buggy when an update happened to set all three fields. */
function parseRuleBody(
  body: unknown,
  op: 'create' | 'update',
): { create: RuleCreate } | { update: RuleUpdate } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['name', 'expr', 'forDuration', 'severity', 'summary', 'description'] as const) {
    if (b[k] !== undefined) {
      if (typeof b[k] !== 'string') return { error: `${k} must be a string` };
      out[k] = b[k];
    }
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
    out.enabled = b.enabled;
  }
  if (op === 'create') {
    // Create requires name + expr + summary; the route translates a missing
    // required field into a 400 with a stable error message.
    if (!('name' in out) || !('expr' in out) || !('summary' in out)) {
      return { error: 'name, expr, and summary are required' };
    }
    return { create: out as unknown as RuleCreate };
  }
  // Update is partial — any subset of the same fields.
  return { update: out as RuleUpdate };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** GET /api/observability/alert-rules  list this org's rules. */
export const listAlertRules = withController('List alert rules', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;

  const rules = await alertRuleService.listForOrg(orgId);
  sendSuccess(res, 200, { rules });
});

/** POST /api/observability/alert-rules  create. Org-admin or above. */
export const createAlertRule = withController('Create alert rule', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;
  // Static `observability:write` gate now enforced at the route
  // (`requirePermission('observability:write')`), visible in the route table.

  const parsed = parseRuleBody(req.body, 'create');
  if ('error' in parsed) return sendError(res, 400, parsed.error);
  if (!('create' in parsed)) return sendError(res, 400, 'name, expr, and summary are required');

  // auto-inject the org_id matcher before validation. Operators can
  // write a vanilla PromQL expr and the service scopes it to their org;
  // any pre-existing `org_id="<theirs>"` is idempotent. A pre-existing
  // matcher targeting a DIFFERENT org throws via PromQLRewriteError.
  try {
    parsed.create.expr = prepareRuleExpr(parsed.create.expr, orgId);
  } catch (err) {
    if (err instanceof PromQLRewriteError) return sendError(res, 400, err.message);
    throw err;
  }
  const validation = validateRule(orgId, parsed.create);
  if (!validation.ok) return sendError(res, 400, validation.message);

  // Per-org cap on alert rules; reserve atomically before insert.
  const reservation = await reserveFeatureQuota(orgId, 'alertRules');
  if (reservation.exceeded) {
    return sendQuotaExceeded(res, 'alertRules', reservation.quota, reservation.quota.resetAt);
  }

  try {
    const rule = await alertRuleService.create(orgId, userId, parsed.create);

    audit(req, 'alert.rule.create', {
      targetType: 'alert-rule',
      targetId: rule.id,
      affectedOrgId: orgId,
      details: { name: rule.name, severity: rule.severity },
    });

    sendSuccess(res, 201, { rule });
  } catch (err) {
    releaseFeatureQuota(orgId, 'alertRules', logger.warn.bind(logger));
    throw err;
  }
});

/** PUT /api/observability/alert-rules/:id  update. Org-admin or above. */
export const updateAlertRule = withController('Update alert rule', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;
  // Static `observability:write` gate now enforced at the route.

  const id = getParam(req.params, 'id')!;

  const parsed = parseRuleBody(req.body, 'update');
  if ('error' in parsed) return sendError(res, 400, parsed.error);

  // After op='update' parsed never carries a `create` branch — branch
  // anyway to satisfy TS narrowing.
  const patch = 'create' in parsed ? parsed.create: parsed.update;
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

  releaseFeatureQuota(orgId, 'alertRules', logger.warn.bind(logger));

  audit(req, 'alert.rule.delete', {
    targetType: 'alert-rule',
    targetId: id,
    affectedOrgId: orgId,
  });

  sendSuccess(res, 200, {});
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
