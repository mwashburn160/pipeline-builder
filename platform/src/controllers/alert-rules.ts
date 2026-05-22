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

import { createLogger, sendError, sendQuotaExceeded, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit';
import { isOrgAdmin, isSystemAdmin, withController } from '../helpers/controller-helper';
import { releaseFeatureQuota, reserveFeatureQuota } from '../middleware/quota';
import { alertRuleService, prepareRuleExpr, renderRulesYaml, validateRule, type RuleCreate, type RuleUpdate } from '../services/alert-rule-service';
import { PromQLRewriteError } from '../services/promql-rewriter';

const logger = createLogger('alert-rules-controller');

/** Validate / coerce the POST/PUT body into a `RuleCreate` / `RuleUpdate`.
 * Returns `null` plus an error response when the body is malformed. */
function parseRuleBody(body: unknown): { create: RuleCreate } | { update: RuleUpdate } | { error: string } {
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
  // Create requires name + expr + summary; update is partial.
  if ('name' in out && 'expr' in out && 'summary' in out) {
    return { create: out as unknown as RuleCreate };
  }
  return { update: out as RuleUpdate };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** GET /api/observability/alert-rules  list this org's rules. */
export const listAlertRules = withController('List alert rules', async (req, res) => {
  const orgId = req.user?.organizationId;
  if (!orgId) return sendError(res, 400, 'organizationId required');

  const rules = await alertRuleService.listForOrg(orgId);
  sendSuccess(res, 200, { rules });
});

/** POST /api/observability/alert-rules  create. Org-admin or above. */
export const createAlertRule = withController('Create alert rule', async (req, res) => {
  const orgId = req.user?.organizationId;
  const userId = req.user?.sub;
  if (!orgId || !userId) return sendError(res, 400, 'organizationId + userId required');
  if (!isOrgAdmin(req) && !isSystemAdmin(req)) {
    return sendError(res, 403, 'Org admin required to create alert rules');
  }

  const parsed = parseRuleBody(req.body);
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
  const orgId = req.user?.organizationId;
  const userId = req.user?.sub;
  if (!orgId || !userId) return sendError(res, 400, 'organizationId + userId required');
  if (!isOrgAdmin(req) && !isSystemAdmin(req)) {
    return sendError(res, 403, 'Org admin required to update alert rules');
  }

  const idRaw = req.params.id;
  const id = String(Array.isArray(idRaw) ? idRaw[0]: idRaw);

  const parsed = parseRuleBody(req.body);
  if ('error' in parsed) return sendError(res, 400, parsed.error);

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
  const orgId = req.user?.organizationId;
  const userId = req.user?.sub;
  if (!orgId || !userId) return sendError(res, 400, 'organizationId + userId required');
  if (!isOrgAdmin(req) && !isSystemAdmin(req)) {
    return sendError(res, 403, 'Org admin required to delete alert rules');
  }

  const idRaw = req.params.id;
  const id = String(Array.isArray(idRaw) ? idRaw[0]: idRaw);

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
