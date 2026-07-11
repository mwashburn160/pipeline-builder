// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  Per-org operator-authored alert rules.
 *
 * Service layer for the `org_alert_rules` table. The materializer renders
 * enabled rules across all orgs into a Prometheus rule_files YAML document
 * served at `GET /api/observability/alert-rules/materialized.yml`.
 *
 * Tenancy gate (`validateRule` → `validateOrgIdMatchers`): a real PromQL
 * matcher walk rejects any `org_id` matcher that doesn't pin the rule to
 * `<orgId>`, and `injectOrgId` auto-injects `org_id="<orgId>"` into selectors
 * that omit it — so a rule can't span tenants.
 * - The materialized rule carries `labels.org_id = <orgId>` so the existing
 * alertmanager-relay routes firing alerts to the right org's destinations.
 */

import { createLogger, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { injectOrgId, PromQLRewriteError, validateOrgIdMatchers } from './promql-rewriter.js';

const logger = createLogger('alert-rule-service');

type OrgAlertRule = typeof schema.orgAlertRule.$inferSelect;

export interface RuleCreate {
  name: string;
  expr: string;
  forDuration?: string;
  severity?: 'warning' | 'critical';
  summary: string;
  description?: string;
  enabled?: boolean;
}

export interface RuleUpdate {
  name?: string;
  expr?: string;
  forDuration?: string;
  severity?: 'warning' | 'critical';
  summary?: string;
  description?: string;
  enabled?: boolean;
}

/** Result shape for validation. `ok=true` cases carry no message. */
export type ValidationResult =
  | { ok: true }
  | { ok: false; message: string };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Prometheus duration syntax. Loose by design  Prometheus rejects malformed
 * durations on reload so we only need to catch the obvious garbage. */
const DURATION_RE = /^(\d+(?:y|w|d|h|m|s|ms))+$/;
/** Alert name must match `^[a-zA-Z_:][a-zA-Z0-9_:]*$` after slugification. */
const NAME_RE = /^[a-zA-Z0-9 _-]+$/;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export class AlertRuleService {
  /**
   *  Auto-inject the `org_id="<orgId>"` matcher into every metric
   * selector in `expr` and return the rewritten string. Route handlers call
   * this BEFORE `validateRule` so an operator who writes
   * `rate(http_requests_total[5m]) > 5` ends up with
   * `rate(http_requests_total{org_id="acme"}[5m]) > 5` in storage. Throws on
   * malformed expressions or cross-tenant attempts.
   */
  static prepareRuleExpr(expr: string, orgId: string): string {
    try {
      return injectOrgId(expr, orgId);
    } catch (err) {
      if (err instanceof PromQLRewriteError) throw err;
      throw new PromQLRewriteError(err instanceof Error ? err.message: String(err));
    }
  }

  /**
   * Validate a rule's user-supplied fields. The org-scoping check is the
   * load-bearing one  it forbids expressions without an `org_id="<orgId>"`
   * matcher, which is the only thing keeping a rule from firing on another
   * tenant's series.
   */
  static validateRule(orgId: string, rule: RuleCreate | RuleUpdate): ValidationResult {
    if (rule.name !== undefined) {
      if (!rule.name.trim()) return { ok: false, message: 'name is required' };
      if (rule.name.length > 100) return { ok: false, message: 'name must be <= 100 chars' };
      if (!NAME_RE.test(rule.name)) return { ok: false, message: 'name may contain letters, digits, space, _, -' };
    }
    if (rule.expr !== undefined) {
      if (!rule.expr.trim()) return { ok: false, message: 'expr is required' };
      // PromQL-aware tenancy gate (replaces the prior substring check).
      // Walks the expression, finds every metric selector, and verifies each
      // one already carries `org_id="<orgId>"` (or the regex form). Catches
      // expressions that try to reference another org's series even when the
      // attacker has appended a decoy matcher in a comment/string.
      const result = validateOrgIdMatchers(rule.expr, orgId);
      if (!result.ok) {
        return {
          ok: false,
          message: `${result.message}. Either add the matcher to every metric or let the service inject it automatically.`,
        };
      }
    }
    if (rule.forDuration !== undefined && !DURATION_RE.test(rule.forDuration)) {
      return { ok: false, message: 'forDuration must be in Prometheus duration syntax (e.g. 30s, 5m, 1h)' };
    }
    if (rule.severity !== undefined && rule.severity !== 'warning' && rule.severity !== 'critical') {
      return { ok: false, message: "severity must be 'warning' or 'critical'" };
    }
    if (rule.summary !== undefined) {
      if (!rule.summary.trim()) return { ok: false, message: 'summary is required' };
      if (rule.summary.length > 500) return { ok: false, message: 'summary must be <= 500 chars' };
    }
    return { ok: true };
  }

  /** List the rules an org has authored, sorted by name for stable UI. */
  async listForOrg(orgId: string): Promise<OrgAlertRule[]> {
    return withTenantTx(async (tx) => tx
      .select()
      .from(schema.orgAlertRule)
      .where(and( eq(schema.orgAlertRule.orgId, orgId),
        isNull(schema.orgAlertRule.deletedAt),
      ))
      .orderBy(asc(schema.orgAlertRule.name)));
  }

  /** Find a single rule by id within the org's scope. */
  async findById(orgId: string, id: string): Promise<OrgAlertRule | null> {
    const rows = await withTenantTx(async (tx) => tx
      .select()
      .from(schema.orgAlertRule)
      .where(and( eq(schema.orgAlertRule.id, id),
        eq(schema.orgAlertRule.orgId, orgId),
        isNull(schema.orgAlertRule.deletedAt),
      ))
      .limit(1));
    return rows[0] ?? null;
  }

  /** Insert. Caller must have already called `validateRule`. */
  async create(orgId: string, actor: string, input: RuleCreate): Promise<OrgAlertRule> {
    const [row] = await withTenantTx(async (tx) => tx
      .insert(schema.orgAlertRule)
      .values({
        orgId,
        createdBy: actor,
        updatedBy: actor,
        name: input.name,
        expr: input.expr,
        forDuration: input.forDuration ?? '5m',
        severity: input.severity ?? 'warning',
        summary: input.summary,
        description: input.description ?? '',
        enabled: input.enabled ?? true,
      })
      .returning());
    logger.info('Alert rule created', { orgId, ruleId: row.id, name: row.name });
    return row;
  }

  /** Update  only fields provided in `input` are touched. */
  async update(orgId: string, id: string, actor: string, input: RuleUpdate): Promise<OrgAlertRule | null> {
    const patch: Partial<typeof schema.orgAlertRule.$inferInsert> = { updatedBy: actor };
    if (input.name !== undefined) patch.name = input.name;
    if (input.expr !== undefined) patch.expr = input.expr;
    if (input.forDuration !== undefined) patch.forDuration = input.forDuration;
    if (input.severity !== undefined) patch.severity = input.severity;
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.description !== undefined) patch.description = input.description;
    if (input.enabled !== undefined) patch.enabled = input.enabled;

    const rows = await withTenantTx(async (tx) => tx
      .update(schema.orgAlertRule)
      .set(patch)
      .where(and( eq(schema.orgAlertRule.id, id),
        eq(schema.orgAlertRule.orgId, orgId),
        isNull(schema.orgAlertRule.deletedAt),
      ))
      .returning());
    return rows[0] ?? null;
  }

  /** Soft-delete. Returns true on success, false if the row was already
   * gone  matches the alert-destination service's semantics. */
  async delete(orgId: string, id: string, actor: string): Promise<boolean> {
    const rows = await withTenantTx(async (tx) => tx
      .update(schema.orgAlertRule)
      .set({ deletedAt: new Date(), deletedBy: actor })
      .where(and( eq(schema.orgAlertRule.id, id),
        eq(schema.orgAlertRule.orgId, orgId),
        isNull(schema.orgAlertRule.deletedAt),
      ))
      .returning());
    return rows.length > 0;
  }

  /**
   * Cross-org scan used by the materializer. Runs under sysadmin tenant
   * context so RLS doesn't filter to a single org. Returns enabled,
   * non-deleted rules across the whole instance.
   */
  async listAllEnabledForMaterializer(): Promise<OrgAlertRule[]> {
    return runWithTenantContext({ orgId: SYSTEM_ORG_ID, isSuperAdmin: true }, async () => {
      return withTenantTx(async (tx) => tx
        .select()
        .from(schema.orgAlertRule)
        .where(and( eq(schema.orgAlertRule.enabled, true),
          isNull(schema.orgAlertRule.deletedAt),
        ))
        .orderBy(asc(schema.orgAlertRule.orgId), asc(schema.orgAlertRule.name)));
    });
  }
}

export const alertRuleService = new AlertRuleService();

// Back-compat named exports — the alert-rules controller imports these
// directly; keep them in sync with the static method bodies above.
export const prepareRuleExpr = AlertRuleService.prepareRuleExpr;
export const validateRule = AlertRuleService.validateRule;

// ---------------------------------------------------------------------------
// Materializer
// ---------------------------------------------------------------------------

/**
 * Slugify a rule name into a valid Prom alert name. Prom alert names must
 * match `[a-zA-Z_:][a-zA-Z0-9_:]*` and we further prefix with the org id
 * so two orgs can both have a rule named "BuildFailure" without colliding.
 */
function toPromAlertName(orgId: string, ruleName: string): string {
  const cleanOrg = orgId.replace(/[^a-zA-Z0-9]/g, '_');
  const cleanName = ruleName.replace(/[^a-zA-Z0-9]/g, '_');
  return `OrgRule_${cleanOrg}_${cleanName}`;
}

/** Escape a string for safe inline YAML output. We render the file by hand
 * rather than via a YAML library so the output is stable + diff-friendly. */
function yq(s: string): string {
  // Wrap in single quotes; double internal single quotes per YAML spec.
  return `'${s.replace(/'/g, "''")}'`;
}

/** Render the full Prometheus rule_files YAML document. Empty when no
 * rules exist  Prometheus accepts an empty `groups: []`. */
export function renderRulesYaml(rules: OrgAlertRule[]): string {
  const header = `#  Operator-authored alert rules.
# Generated by platform's GET /api/observability/alert-rules/materialized.yml.
# Hand edits are overwritten on the next render  author via the platform API.
`;
  if (rules.length === 0) {
    return `${header}groups: []\n`;
  }
  const lines: string[] = [header, 'groups:'];
  lines.push(' - name: org-authored');
  lines.push(' rules:');
  for (const r of rules) {
    const promName = toPromAlertName(r.orgId, r.name);
    lines.push(` - alert: ${promName}`);
    // Render expr as a YAML block scalar to preserve newlines + quoting
    // without us having to escape every promQL character.
    lines.push(' expr: |');
    for (const line of r.expr.split(/\r?\n/)) lines.push(` ${line}`);
    lines.push(` for: ${r.forDuration}`);
    lines.push(' labels:');
    lines.push(` severity: ${r.severity}`);
    lines.push(' component: org-authored');
    // `tenancy: org` + the `org_id` label route this alert through the
    // existing alertmanager-relay to the org's destinations.
    lines.push(' tenancy: org');
    lines.push(` org_id: ${yq(r.orgId)}`);
    lines.push(' annotations:');
    lines.push(` summary: ${yq(r.summary)}`);
    if (r.description) {
      lines.push(` description: ${yq(r.description)}`);
    }
  }
  return lines.join('\n') + '\n';
}
