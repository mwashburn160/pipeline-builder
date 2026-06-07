// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createCacheService, createLogger, errorMessage } from '@pipeline-builder/api-core';
import {
  CoreConstants,
  CrudService,
  buildComplianceRuleConditions,
  buildPublishedRuleCatalogConditions,
  runWithTenantContext,
  schema,
  withTenantTx,
  type ComplianceRuleFilter,
  type RuleTarget,
  type RuleScope,
  drizzleCount,
} from '@pipeline-builder/pipeline-core';
import { SQL, eq, and, desc, inArray, isNull, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';
import { validateRuleRegexPatterns } from '../engine/rule-operators';
import { notifyPublishedRuleChange } from '../helpers/rule-change-notifier';

/**
 * Thrown by `create`/`update` when one of the rule's regex operators fails
 * to compile. Routes catch this and surface a 400. Domain-typed via a class
 * (rather than a string code) because the user-facing message comes from
 * the `RegExp` engine and is per-rule.
 */
export class InvalidRuleRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRuleRegexError';
  }
}

const logger = createLogger('compliance-rule-service');

/** Cache for active rules per org+target. Rules change infrequently. */
const rulesCache = createCacheService('compliance:rules:', CoreConstants.CACHE_TTL_COMPLIANCE_RULES);

export type ComplianceRule = typeof schema.complianceRule.$inferSelect;
export type ComplianceRuleInsert = typeof schema.complianceRule.$inferInsert;
export type ComplianceRuleUpdate = Partial<Omit<ComplianceRule, 'id' | 'createdAt' | 'createdBy'>>;

export class ComplianceRuleService extends CrudService<
  ComplianceRule,
  ComplianceRuleFilter,
  ComplianceRuleInsert,
  ComplianceRuleUpdate
> {
  protected get schema(): PgTable {
    return schema.complianceRule as PgTable;
  }

  protected buildConditions(filter: Partial<ComplianceRuleFilter>, orgId?: string): SQL[] {
    return buildComplianceRuleConditions(filter, orgId);
  }

  protected getSortColumn(sortBy: string): AnyColumn | null {
    const cols: Record<string, AnyColumn> = {
      name: schema.complianceRule.name,
      priority: schema.complianceRule.priority,
      severity: schema.complianceRule.severity,
      createdAt: schema.complianceRule.createdAt,
      updatedAt: schema.complianceRule.updatedAt,
    };
    return cols[sortBy] || null;
  }

  protected getProjectColumn(): AnyColumn | null {
    return null; // Org-scoped
  }

  protected getOrgColumn(): AnyColumn {
    return schema.complianceRule.orgId;
  }

  protected get conflictTarget(): AnyColumn[] {
    return [schema.complianceRule.orgId, schema.complianceRule.name];
  }

  /**
   * Fetch active rules for an org+target, ordered by priority DESC.
   * Includes the org's own rules and any subscribed published rules.
   * Results are cached per org+target (configurable TTL).
   */
  async findActiveByOrgAndTarget(orgId: string, target: RuleTarget, parentOrgId?: string): Promise<ComplianceRule[]> {
    // The 'system' org is inert for compliance enforcement: it's the operator
    // home for the template/published rule LIBRARY and the bootstrap
    // plugin/pipeline catalog, not a tenant. Its own rules are never active
    // policy against its own content (otherwise a bootstrap plugin upload —
    // orgId='system' — evaluates the whole library against itself and blocks).
    // Returning [] here makes system inert across every caller: validate
    // (upload), entity events, scheduled scans, and the /enforced view.
    if (orgId === 'system') return [];

    // Parent org id determines visibility of parent-propagated rules, so it's
    // the trailing key segment (`${child}:${target}:${parent}`). This lets
    // `invalidateRulesCache(parentOrgId)` clear descendants via the `*:${parent}`
    // pattern when a parent edits a `propagateToChildren` rule — so children
    // pick up the change immediately, not at TTL.
    const cacheKey = `${orgId}:${target}:${parentOrgId ?? ''}`;
    return rulesCache.getOrSet(cacheKey, async () => {
      // Single query: org's own rules UNION subscribed published rules (via LEFT JOIN)
      const orgRules = await this.find({ target, isActive: true } as Partial<ComplianceRuleFilter>, orgId);

      // Fetch subscribed published rules + the subscription row itself so we
      // can honor a `pinnedVersion` snapshot when present.
      const publishedRows = await withTenantTx(async (tx) => tx
        .select({ rule: schema.complianceRule, subscription: schema.complianceRuleSubscription })
        .from(schema.complianceRuleSubscription)
        .innerJoin(
          schema.complianceRule,
          and(
            eq(schema.complianceRuleSubscription.ruleId, schema.complianceRule.id),
            eq(schema.complianceRule.target, target),
            eq(schema.complianceRule.isActive, true),
            eq(schema.complianceRule.scope, 'published' as RuleScope),
          ),
        )
        .where(and(
          eq(schema.complianceRuleSubscription.orgId, orgId),
          eq(schema.complianceRuleSubscription.isActive, true),
        )));

      // Org → team hierarchy: a team also enforces its parent's rules flagged
      // `propagateToChildren`. The parent's rows are outside this org's RLS
      // scope, so read them under sysadmin context (same pattern as the
      // cross-org reads elsewhere in this service).
      const parentRules = parentOrgId
        ? await runWithTenantContext({ isSuperAdmin: true }, () =>
          withTenantTx(async (tx) => tx
            .select()
            .from(schema.complianceRule)
            .where(and(
              eq(schema.complianceRule.orgId, parentOrgId),
              eq(schema.complianceRule.target, target),
              eq(schema.complianceRule.isActive, true),
              eq(schema.complianceRule.propagateToChildren, true),
            )))) as ComplianceRule[]
        : [];

      // Merge, deduplicate by ID. Prefer the pinned snapshot for subscribed
      // published rules — the body the org last explicitly accepted.
      const seenIds = new Set(orgRules.map(r => r.id));
      const merged = [...orgRules];
      for (const rule of parentRules) {
        if (seenIds.has(rule.id)) continue;
        merged.push(rule);
        seenIds.add(rule.id);
      }
      for (const { rule, subscription } of publishedRows) {
        if (seenIds.has(rule.id)) continue;
        const pinned = (subscription as { pinnedVersion?: unknown }).pinnedVersion as Partial<ComplianceRule> | null | undefined;
        const effective = pinned ? { ...rule, ...pinned } as ComplianceRule : (rule as ComplianceRule);
        merged.push(effective);
        seenIds.add(rule.id);
      }
      return merged;
    });
  }

  /**
   * Invalidate cached rules for an org (called after rule mutations or
   * subscription changes). Clears two key shapes:
   *  - `${orgId}:*`  — this org's own evaluation cache.
   *  - `*:${orgId}`  — descendant teams that cached this org as their parent
   *    (their key is `${child}:${target}:${orgId}`), so a parent's
   *    `propagateToChildren` rule edit is reflected immediately rather than at
   *    TTL. Depth is capped at one level, so only direct children carry the key.
   */
  async invalidateRulesCache(orgId: string): Promise<void> {
    await Promise.all([
      rulesCache.invalidatePattern(`${orgId}:*`),
      rulesCache.invalidatePattern(`*:${orgId}`),
    ]);
  }

  /**
   * Invalidate cached rules for all orgs subscribed to a published rule.
   * Called after a published rule is mutated so subscribers pick up the change.
   */
  private async invalidateSubscriberCaches(ruleId: string): Promise<void> {
    // Published-rule subscribers span every org — this is a legitimate
    // cross-tenant read, so escalate to sysadmin scope.
    const subscribers = await runWithTenantContext({ isSuperAdmin: true }, () =>
      withTenantTx(async (tx) => tx
        .select({ orgId: schema.complianceRuleSubscription.orgId })
        .from(schema.complianceRuleSubscription)
        .where(and(
          eq(schema.complianceRuleSubscription.ruleId, ruleId),
          eq(schema.complianceRuleSubscription.isActive, true),
        ))),
    );

    await Promise.all(subscribers.map((s: { orgId: string }) => this.invalidateRulesCache(s.orgId)));
  }

  /** Fetch paginated rule change history for a specific rule. */
  async findRuleHistory(
    ruleId: string,
    orgId: string,
    options: { limit: number; offset: number },
  ): Promise<{ history: unknown[]; total: number }> {
    const conditions = and(
      eq(schema.complianceRuleHistory.ruleId, ruleId),
      eq(schema.complianceRuleHistory.orgId, orgId),
    );

    const [countResult] = await withTenantTx(async (tx) => tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.complianceRuleHistory)
      .where(conditions).then((r: unknown[]) => drizzleCount(r)));

    const history = await withTenantTx(async (tx) => tx
      .select()
      .from(schema.complianceRuleHistory)
      .where(conditions)
      .orderBy(desc(schema.complianceRuleHistory.changedAt))
      .limit(options.limit)
      .offset(options.offset));

    return { history, total: countResult?.count ?? 0 };
  }

  /**
   * Clone a published rule into the org's own rules.
   *
   * Creates a copy with scope='org' and tracks the source via forkedFromRuleId
   * (column name kept for schema-compat). One-shot copy — no upstream sync,
   * no notification when the source rule changes. If the org wants future
   * upstream changes, they should subscribe instead of clone.
   *
   * Previously named `forkRule`; "fork" carried git connotations (track upstream
   * for merge) we never delivered. Renamed outright — there is no back-compat alias.
   */
  async cloneRule(ruleId: string, orgId: string, userId: string): Promise<ComplianceRule> {
    // Published rules live with scope='published' and don't share the caller's
    // orgId; read them under sysadmin scope so RLS doesn't filter them out.
    const [sourceRule] = await runWithTenantContext({ isSuperAdmin: true }, () =>
      withTenantTx(async (tx) => tx
        .select()
        .from(schema.complianceRule)
        .where(and(
          eq(schema.complianceRule.id, ruleId),
          eq(schema.complianceRule.scope, 'published' as RuleScope),
          eq(schema.complianceRule.isActive, true),
          isNull(schema.complianceRule.deletedAt),
        ))),
    );

    if (!sourceRule) throw new Error('Published rule not found');

    const cloned = await this.create({
      orgId,
      name: `${sourceRule.name}-custom`,
      description: sourceRule.description ?? undefined,
      policyId: undefined,
      priority: sourceRule.priority,
      target: sourceRule.target,
      severity: sourceRule.severity,
      tags: sourceRule.tags as string[],
      scope: 'org' as RuleScope,
      suppressNotification: sourceRule.suppressNotification,
      field: sourceRule.field ?? undefined,
      operator: sourceRule.operator ?? undefined,
      value: sourceRule.value ?? undefined,
      conditions: (sourceRule.conditions as unknown as ComplianceRuleInsert['conditions']) ?? undefined,
      conditionMode: sourceRule.conditionMode ?? undefined,
      forkedFromRuleId: ruleId,
      createdBy: userId,
      updatedBy: userId,
    } as ComplianceRuleInsert, userId);

    return cloned;
  }

  /**
   * Feature #6: Get all enforced rules for an org (org rules + active subscribed rules merged).
   */
  async findAllEnforced(orgId: string, target?: RuleTarget, parentOrgId?: string): Promise<ComplianceRule[]> {
    const targets: RuleTarget[] = target ? [target] : ['plugin', 'pipeline'];
    const allRules: ComplianceRule[] = [];

    for (const t of targets) {
      const rules = await this.findActiveByOrgAndTarget(orgId, t, parentOrgId);
      allRules.push(...rules);
    }

    return allRules;
  }

  /**
   * Fire-and-forget: create a pending scan triggered by a rule change.
   * The scan scheduler picks it up and executes it automatically.
   *
   * Coalesces by (orgId, target): if a pending or running scan for the same
   * pair already exists, skip the insert. Avoids backlog buildup when many
   * rules are mutated in quick succession (e.g. bulk imports).
   */
  private async triggerRuleChangeScan(orgId: string, target: string, userId: string = 'system'): Promise<void> {
    await withTenantTx(async (tx) => {
      const [existing] = await tx
        .select({ id: schema.complianceScan.id })
        .from(schema.complianceScan)
        .where(and(
          eq(schema.complianceScan.orgId, orgId),
          eq(schema.complianceScan.target, target as 'plugin' | 'pipeline'),
          inArray(schema.complianceScan.status, ['pending', 'running']),
        ))
        .limit(1);
      if (existing) return;

      await tx.insert(schema.complianceScan).values({
        orgId,
        target: target as 'plugin' | 'pipeline',
        status: 'pending',
        triggeredBy: 'rule-change',
        userId,
      });
    });
  }

  /** Fetch all rules belonging to a policy. */
  async findByPolicy(policyId: string, orgId: string): Promise<ComplianceRule[]> {
    return this.find({ policyId, isActive: true } as Partial<ComplianceRuleFilter>, orgId);
  }

  /**
   * Paginated browse of the published-rule catalog, filtered by name/target/
   * severity/tag. Returns rules ordered by priority DESC plus the total count.
   */
  async listPublishedCatalog(
    filter: { name?: string; target?: 'plugin' | 'pipeline'; severity?: 'warning' | 'error' | 'critical'; tag?: string },
    limit: number,
    offset: number,
  ) {
    const conditions = buildPublishedRuleCatalogConditions(filter);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Published catalog browse is cross-tenant by definition — any org can
    // browse the published rule library. Read under sysadmin scope.
    return runWithTenantContext({ isSuperAdmin: true }, async () => {
      const [countResult] = await withTenantTx(async (tx) => tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.complianceRule)
        .where(whereClause)
        .then((r: unknown[]) => drizzleCount(r)));

      const rules = await withTenantTx(async (tx) => tx
        .select()
        .from(schema.complianceRule)
        .where(whereClause)
        .orderBy(desc(schema.complianceRule.priority))
        .limit(limit)
        .offset(offset));

      return { rules: rules as unknown as ComplianceRule[], total: countResult?.count ?? 0 };
    });
  }

  /** Batch lookup of non-deleted rules by id. */
  async findManyByIds(ids: string[]): Promise<ComplianceRule[]> {
    if (ids.length === 0) return [];
    // Caller-side scope decision: this is used by the subscription flow which
    // needs to look up published rules from any org. Sysadmin scope.
    const rows = await runWithTenantContext({ isSuperAdmin: true }, () =>
      withTenantTx(async (tx) => tx
        .select()
        .from(schema.complianceRule)
        .where(and(
          inArray(schema.complianceRule.id, ids),
          eq(schema.complianceRule.isActive, true),
          isNull(schema.complianceRule.deletedAt),
        ))),
    );
    return rows as unknown as ComplianceRule[];
  }

  /** Single rule by id, ignoring soft-deleted/inactive rows. Returns null on miss. */
  async findPublishedById(id: string): Promise<ComplianceRule | null> {
    const [rule] = await runWithTenantContext({ isSuperAdmin: true }, () =>
      withTenantTx(async (tx) => tx
        .select()
        .from(schema.complianceRule)
        .where(and(
          eq(schema.complianceRule.id, id),
          eq(schema.complianceRule.isActive, true),
          isNull(schema.complianceRule.deletedAt),
        ))),
    );
    return (rule ?? null) as ComplianceRule | null;
  }

  /**
   * Fetch the caller's active plugins or pipelines for impact-preview
   * evaluation. Each row is normalized to `{ id, name, raw }` so the rule
   * engine can run against the raw record without target-specific code paths.
   */
  async findOrgEntitiesForTarget(
    target: 'plugin' | 'pipeline',
    orgId: string,
    limit: number,
  ): Promise<Array<{ id: string; name: string | null; raw: Record<string, unknown> }>> {
    if (target === 'plugin') {
      const rows = await withTenantTx(async (tx) => tx
        .select()
        .from(schema.plugin)
        .where(and(eq(schema.plugin.isActive, true), eq(schema.plugin.orgId, orgId)))
        .limit(limit));
      return rows.map((r: typeof schema.plugin.$inferSelect) => ({ id: r.id, name: r.name, raw: r as unknown as Record<string, unknown> }));
    }
    const rows = await withTenantTx(async (tx) => tx
      .select()
      .from(schema.pipeline)
      .where(and(eq(schema.pipeline.isActive, true), eq(schema.pipeline.orgId, orgId)))
      .limit(limit));
    return rows.map((r: typeof schema.pipeline.$inferSelect) => ({ id: r.id, name: r.pipelineName, raw: r as unknown as Record<string, unknown> }));
  }

  /**
   * Record a rule change in the history table.
   * Called automatically by overridden create/update/delete.
   */
  async recordHistory(
    ruleId: string,
    orgId: string,
    changeType: string,
    previousState: unknown,
    userId: string,
  ): Promise<void> {
    await withTenantTx(async (tx) => tx.insert(schema.complianceRuleHistory).values({
      ruleId,
      orgId,
      changeType,
      previousState: previousState as Record<string, unknown>,
      changedBy: userId,
    }));
  }

  // Override mutations to record history

  async create(data: ComplianceRuleInsert, userId: string): Promise<ComplianceRule> {
    // validateRuleRegexPatterns is structural over `operator?: string` etc.;
    // the schema's `RuleOperator | null` is compatible at runtime but TS
    // can't narrow the union, so cast to the validator's input shape.
    const regexError = validateRuleRegexPatterns(data as Parameters<typeof validateRuleRegexPatterns>[0]);
    if (regexError) throw new InvalidRuleRegexError(regexError);
    const created = await super.create(data, userId);
    this.recordHistory(created.id, created.orgId, 'created', null, userId).catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
    this.invalidateRulesCache(created.orgId).catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
    this.triggerRuleChangeScan(created.orgId, created.target, userId).catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
    if (created.scope === 'published') {
      this.invalidateSubscriberCaches(created.id).catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
    }
    return created;
  }

  async update(
    id: string,
    data: Partial<ComplianceRuleUpdate>,
    orgId: string,
    userId: string,
  ): Promise<ComplianceRule | null> {
    const regexError = validateRuleRegexPatterns(data as Parameters<typeof validateRuleRegexPatterns>[0]);
    if (regexError) throw new InvalidRuleRegexError(regexError);
    const existing = await this.findById(id, orgId);
    const updated = await super.update(id, data, orgId, userId);
    if (updated && existing) {
      this.recordHistory(id, orgId, 'updated', existing, userId).catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
      this.invalidateRulesCache(orgId).catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
      this.triggerRuleChangeScan(orgId, existing.target, userId).catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
      if (existing.scope === 'published') {
        this.invalidateSubscriberCaches(id).catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
        notifyPublishedRuleChange(id, existing.name, 'updated').catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
      }
    }
    return updated;
  }

  async delete(id: string, orgId: string, userId: string): Promise<ComplianceRule | null> {
    const existing = await this.findById(id, orgId);
    const deleted = await super.delete(id, orgId, userId);
    if (deleted && existing) {
      this.recordHistory(id, orgId, 'deleted', existing, userId).catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
      this.invalidateRulesCache(orgId).catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
      this.triggerRuleChangeScan(orgId, existing.target, userId).catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
      if (existing.scope === 'published') {
        this.invalidateSubscriberCaches(id).catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
        notifyPublishedRuleChange(id, existing.name, 'deleted').catch((err: unknown) => logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }));
      }
    }
    return deleted;
  }
}

export const complianceRuleService = new ComplianceRuleService();
