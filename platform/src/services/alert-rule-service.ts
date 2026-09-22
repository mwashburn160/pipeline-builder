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

import { createLogger, errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { runWithTenantContext, schema, withTenantTx, softDeleteRetentionMs } from '@pipeline-builder/pipeline-data';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import YAML from 'yaml';
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
export type AlertRuleValidationResult =
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
// Expression preparation + validation
//
// Module-level functions (not class statics): the controller is the only
// caller and imports them by name, so a single definition is also the single
// export — no delegating alias to keep in sync.
// ---------------------------------------------------------------------------

/**
 *  Auto-inject the `org_id="<orgId>"` matcher into every metric
 * selector in `expr` and return the rewritten string. Route handlers call
 * this BEFORE `validateRule` so an operator who writes
 * `rate(http_requests_total[5m]) > 5` ends up with
 * `rate(http_requests_total{org_id="acme"}[5m]) > 5` in storage. Throws on
 * malformed expressions or cross-tenant attempts.
 */
export function prepareRuleExpr(expr: string, orgId: string): string {
  try {
    return injectOrgId(expr, orgId);
  } catch (err) {
    if (err instanceof PromQLRewriteError) throw err;
    throw new PromQLRewriteError(errorMessage(err));
  }
}

/**
 * Validate a rule's user-supplied fields. The org-scoping check is the
 * load-bearing one  it forbids expressions without an `org_id="<orgId>"`
 * matcher, which is the only thing keeping a rule from firing on another
 * tenant's series.
 */
export function validateRule(orgId: string, rule: RuleCreate | RuleUpdate): AlertRuleValidationResult {
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
    if (hasTemplateSyntax(rule.summary)) return { ok: false, message: TEMPLATE_REJECTION('summary') };
  }
  if (rule.description !== undefined) {
    if (rule.description.length > 2000) return { ok: false, message: 'description must be <= 2000 chars' };
    if (hasTemplateSyntax(rule.description)) return { ok: false, message: TEMPLATE_REJECTION('description') };
  }
  return { ok: true };
}

/**
 * Prometheus evaluates alert annotations as Go templates, and its template
 * functions include `query` — which runs arbitrary PromQL with the rule
 * engine's (cross-tenant) view. A `{{ query "…" }}` in an org's summary would
 * read other tenants' series straight into that org's notification, bypassing
 * the expr tenancy gate entirely. So operator text is plain text: any template
 * delimiter is rejected at write, and `renderRulesYaml` neutralizes any that
 * reach it anyway.
 */
function hasTemplateSyntax(s: string): boolean {
  return s.includes('{{') || s.includes('}}');
}

function TEMPLATE_REJECTION(field: string): string {
  return `${field} may not contain template syntax ({{ or }}); annotations are rendered as literal text`;
}

/**
 * Render operator text so Prometheus's Go-template pass prints it verbatim:
 * each `{{` / `}}` becomes an action that emits that delimiter as a raw-string
 * literal. Single pass, so an escape is never re-escaped.
 */
function literalTemplateText(s: string): string {
  return s.replace(/\{\{|\}\}/g, (d) => `{{\`${d}\`}}`);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export class AlertRuleService {
  /** List the rules an org has authored, sorted by name for stable UI. */
  async listForOrg(
    orgId: string,
    page: { offset: number; limit: number },
  ): Promise<{ rules: OrgAlertRule[]; total: number }> {
    const live = and(eq(schema.orgAlertRule.orgId, orgId), isNull(schema.orgAlertRule.deletedAt));
    // One tenant tx for the page + the count, so both see the same snapshot and
    // `total` can't disagree with the page it describes.
    // (Sequential: a transaction owns a single connection.)
    return withTenantTx(async (tx) => {
      const rules = await tx.select().from(schema.orgAlertRule).where(live)
        // `id` breaks name ties so paging is deterministic.
        .orderBy(asc(schema.orgAlertRule.name), asc(schema.orgAlertRule.id))
        .limit(page.limit)
        .offset(page.offset);
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(schema.orgAlertRule).where(live);
      return { rules, total: Number(count) };
    });
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
    const now = new Date();
    const retentionMs = softDeleteRetentionMs();
    const rows = await withTenantTx(async (tx) => tx
      .update(schema.orgAlertRule)
      .set({ deletedAt: now, deletedBy: actor, ...(retentionMs > 0 ? { purgeAfter: new Date(now.getTime() + retentionMs) } : {}) })
      .where(and( eq(schema.orgAlertRule.id, id),
        eq(schema.orgAlertRule.orgId, orgId),
        isNull(schema.orgAlertRule.deletedAt),
      ))
      .returning());
    return rows.length > 0;
  }

  /** List this org's soft-deleted rules (tombstones), newest-deleted first —
   *  the "recently deleted" restore panel's backing read. Org-scoped like every
   *  other read here, so a tombstone never crosses tenants. */
  async listDeletedForOrg(orgId: string): Promise<OrgAlertRule[]> {
    return withTenantTx(async (tx) => tx
      .select()
      .from(schema.orgAlertRule)
      .where(and(
        eq(schema.orgAlertRule.orgId, orgId),
        sql`${schema.orgAlertRule.deletedAt} IS NOT NULL`,
      ))
      .orderBy(desc(schema.orgAlertRule.deletedAt)));
  }

  /** Find a soft-deleted rule by id within the org — the tombstone lookup the
   *  purge route gates on (and takes the audit `name` from). */
  async findDeletedById(orgId: string, id: string): Promise<OrgAlertRule | null> {
    const rows = await withTenantTx(async (tx) => tx
      .select()
      .from(schema.orgAlertRule)
      .where(and(
        eq(schema.orgAlertRule.id, id),
        eq(schema.orgAlertRule.orgId, orgId),
        sql`${schema.orgAlertRule.deletedAt} IS NOT NULL`,
      ))
      .limit(1));
    return rows[0] ?? null;
  }

  /** Hard-delete one TOMBSTONE, finalizing what the retention sweep would do at
   *  `purge_after`. Matches only `deleted_at IS NOT NULL`, so a live rule can
   *  never be destroyed here — it must be soft-deleted first. */
  async purgeById(orgId: string, id: string): Promise<boolean> {
    const rows = await withTenantTx(async (tx) => tx
      .delete(schema.orgAlertRule)
      .where(and(
        eq(schema.orgAlertRule.id, id),
        eq(schema.orgAlertRule.orgId, orgId),
        sql`${schema.orgAlertRule.deletedAt} IS NOT NULL`,
      ))
      .returning({ id: schema.orgAlertRule.id }));
    return rows.length > 0;
  }

  /** Restore a soft-deleted rule (clear deletedAt/deletedBy), org-scoped. A
   *  restored enabled rule re-enters the materializer on its next poll. Returns
   *  false when there is no matching tombstone in the org. */
  async restore(orgId: string, id: string, actor: string): Promise<boolean> {
    const rows = await withTenantTx(async (tx) => tx
      .update(schema.orgAlertRule)
      .set({ deletedAt: null, deletedBy: null, updatedAt: new Date(), updatedBy: actor })
      .where(and(
        eq(schema.orgAlertRule.id, id),
        eq(schema.orgAlertRule.orgId, orgId),
        sql`${schema.orgAlertRule.deletedAt} IS NOT NULL`,
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

/** Render the full Prometheus rule_files YAML document. Empty when no
 * rules exist  Prometheus accepts an empty `groups: []`. Serialized by the
 * `yaml` library (never hand-indented) so every operator-supplied string is
 * a quoted/escaped scalar that cannot break out of its node. */
export function renderRulesYaml(rules: OrgAlertRule[]): string {
  const header = `#  Operator-authored alert rules.
# Generated by platform's GET /api/observability/alert-rules/materialized.yml.
# Hand edits are overwritten on the next render  author via the platform API.
`;
  if (rules.length === 0) {
    return `${header}groups: []\n`;
  }
  const doc = {
    groups: [{
      name: 'org-authored',
      rules: rules.map((r) => ({
        alert: toPromAlertName(r.orgId, r.name),
        expr: r.expr,
        for: r.forDuration,
        labels: {
          severity: r.severity,
          component: 'org-authored',
          // `tenancy: org` + the `org_id` label route this alert through the
          // existing alertmanager-relay to the org's destinations.
          tenancy: 'org',
          org_id: r.orgId,
        },
        annotations: {
          summary: literalTemplateText(r.summary),
          ...(r.description ? { description: literalTemplateText(r.description) } : {}),
        },
      })),
    }],
  };
  return header + YAML.stringify(doc, { lineWidth: 0 });
}
