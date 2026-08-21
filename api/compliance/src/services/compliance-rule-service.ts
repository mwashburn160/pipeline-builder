// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createCacheService, createLogger, errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { CrudService, buildComplianceRuleConditions, buildPublishedRuleCatalogConditions, runWithTenantContext, schema, withTenantTx, type ComplianceRuleFilter, type RuleTarget, type RuleScope } from '@pipeline-builder/pipeline-data';
import { SQL, eq, and, desc, inArray, isNull } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';
import { paginatedList } from './paginated-list.js';
import { subscriptionService, KNOWN_CONTENT_SETS } from './subscription-service.js';
import { validateRuleRegexPatterns } from '../engine/rule-operators.js';
import { notifyPublishedRuleChange } from '../helpers/rule-change-notifier.js';

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

/**
 * Thrown by `create`/`update` when a PUBLISHED rule carries a `set:<x>` tag whose
 * `<x>` isn't a KNOWN content set. A typo'd `set:advance` would otherwise be
 * invisible to the entitlement gate (which only recognizes `set:standard` /
 * `set:advanced`) — enforced for free to everyone AND absent from any paid
 * library. Routes catch this and surface a 400.
 */
export class InvalidSetTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSetTagError';
  }
}

const KNOWN_CONTENT_SET_NAMES: ReadonlySet<string> = new Set(KNOWN_CONTENT_SETS);

/**
 * Reject a published rule whose tags include a `set:<x>` marker with an unknown
 * `<x>`. Returns an error message (for `InvalidSetTagError`) or null when valid.
 * Only meaningful for `scope='published'` rules — org-scoped rules are neither
 * entitlement-gated nor catalog-listed, so a stray `set:` tag on them is inert.
 */
function invalidSetTagMessage(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags as string[]) {
    if (typeof tag !== 'string' || !tag.startsWith('set:')) continue;
    const name = tag.slice('set:'.length);
    if (!KNOWN_CONTENT_SET_NAMES.has(name)) {
      return `Unknown content set tag "${tag}" — must be one of: ${KNOWN_CONTENT_SETS.map((s) => `set:${s}`).join(', ')}`;
    }
  }
  return null;
}

const logger = createLogger('compliance-rule-service');

/** Shared `.catch` sink for the fire-and-forget side effects (history / cache /
 *  scan-trigger) in create/update/delete/restore — was copy-pasted 16×. */
const warnNonFatal = (err: unknown): void => { logger.warn('Non-fatal side effect failed', { error: errorMessage(err) }); };

/** Cache for active rules per org+target. Rules change infrequently. */
const rulesCache = createCacheService('compliance:rules:', CoreConstants.CACHE_TTL_COMPLIANCE_RULES);

export type ComplianceRule = typeof schema.complianceRule.$inferSelect;
export type ComplianceRuleInsert = typeof schema.complianceRule.$inferInsert;
export type ComplianceRuleUpdate = Partial<Omit<ComplianceRule, 'id' | 'createdAt' | 'createdBy'>>;

/**
 * Build a `ComplianceRuleInsert` copying the evaluable body of a source rule
 * (priority/target/severity/tags/scope/field/operator/value/conditions/…), with
 * `overrides` for the per-clone bits (orgId, name, policyId, forkedFromRuleId,
 * createdBy/updatedBy). Shared by `cloneRule` (fork a published rule) and
 * `cloneTemplate` (materialize a policy template) — was hand-built in both, the
 * policy copy via an `as unknown as` double-cast this removes.
 */
export function ruleInsertFromSource(source: ComplianceRule, overrides: Partial<ComplianceRuleInsert>): ComplianceRuleInsert {
  return {
    name: source.name,
    description: source.description ?? undefined,
    priority: source.priority,
    target: source.target,
    severity: source.severity,
    tags: source.tags as string[],
    scope: 'org' as RuleScope,
    suppressNotification: source.suppressNotification,
    field: source.field ?? undefined,
    operator: source.operator ?? undefined,
    value: source.value ?? undefined,
    conditions: (source.conditions as unknown as ComplianceRuleInsert['conditions']) ?? undefined,
    conditionMode: source.conditionMode ?? undefined,
    ...overrides,
  } as ComplianceRuleInsert;
}

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
    if (orgId === SYSTEM_ORG_ID) return [];

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
            // Soft-delete-aware, like every other published-rule read in this file:
            // a soft-deleted rule must stop being enforced for subscribers.
            isNull(schema.complianceRule.deletedAt),
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
              // A soft-deleted parent rule must stop propagating to children.
              isNull(schema.complianceRule.deletedAt),
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

    const { rows, total } = await paginatedList(
      schema.complianceRuleHistory,
      conditions,
      desc(schema.complianceRuleHistory.changedAt),
      options.limit,
      options.offset,
    );
    return { history: rows, total };
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

    const cloned = await this.create(ruleInsertFromSource(sourceRule, {
      orgId,
      name: `${sourceRule.name}-custom`,
      policyId: undefined,
      forkedFromRuleId: ruleId,
      createdBy: userId,
      updatedBy: userId,
    }), userId);

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
    // browse the published rule library. Read under sysadmin scope (the shared
    // paginatedList runs its withTenantTx inside this context).
    return runWithTenantContext({ isSuperAdmin: true }, async () => {
      const { rows, total } = await paginatedList<ComplianceRule>(
        schema.complianceRule,
        whereClause,
        desc(schema.complianceRule.priority),
        limit,
        offset,
      );
      return { rules: rows, total };
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

  /**
   * Single PUBLISHED rule by id, ignoring soft-deleted/inactive rows. Returns
   * null on miss. Runs under sysadmin scope (published rules don't share the
   * caller's orgId), so the `scope='published'` filter is REQUIRED — without it
   * this would return any org's private rule by UUID (cross-tenant disclosure).
   */
  async findPublishedById(id: string): Promise<ComplianceRule | null> {
    const [rule] = await runWithTenantContext({ isSuperAdmin: true }, () =>
      withTenantTx(async (tx) => tx
        .select()
        .from(schema.complianceRule)
        .where(and(
          eq(schema.complianceRule.id, id),
          eq(schema.complianceRule.scope, 'published' as RuleScope),
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
    // Guard published rules against typo'd/unknown `set:<x>` tags (see
    // InvalidSetTagError). Org-scoped rules are unaffected.
    if ((data as { scope?: RuleScope }).scope === 'published') {
      const setTagError = invalidSetTagMessage((data as { tags?: unknown }).tags);
      if (setTagError) throw new InvalidSetTagError(setTagError);
    }
    const created = await super.create(data, userId);
    this.recordHistory(created.id, created.orgId, 'created', null, userId).catch(warnNonFatal);
    this.invalidateRulesCache(created.orgId).catch(warnNonFatal);
    this.triggerRuleChangeScan(created.orgId, created.target, userId).catch(warnNonFatal);
    if (created.scope === 'published') {
      this.invalidateSubscriberCaches(created.id).catch(warnNonFatal);
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
    // A published rule whose tags are being updated must not introduce an
    // unknown `set:<x>` tag. The update body carries no `scope`, so the target
    // rule's stored scope decides whether the guard applies.
    if (existing?.scope === 'published' && (data as { tags?: unknown }).tags !== undefined) {
      const setTagError = invalidSetTagMessage((data as { tags?: unknown }).tags);
      if (setTagError) throw new InvalidSetTagError(setTagError);
    }
    const updated = await super.update(id, data, orgId, userId);
    if (updated && existing) {
      this.recordHistory(id, orgId, 'updated', existing, userId).catch(warnNonFatal);
      this.invalidateRulesCache(orgId).catch(warnNonFatal);
      this.triggerRuleChangeScan(orgId, existing.target, userId).catch(warnNonFatal);
      if (existing.scope === 'published') {
        this.invalidateSubscriberCaches(id).catch(warnNonFatal);
        notifyPublishedRuleChange(id, existing.name, 'updated').catch(warnNonFatal);
      }
    }
    return updated;
  }

  async delete(id: string, orgId: string, userId: string): Promise<ComplianceRule | null> {
    const existing = await this.findById(id, orgId);
    // Capture the subscriber list BEFORE the soft-delete. `findSubscribers`
    // inner-joins on `isNull(deletedAt)`, so once `super.delete()` sets
    // `deletedAt` it returns zero rows — the deletion notification would then
    // reach no one. Snapshot it first and hand it to the notifier explicitly.
    const subscribers = existing?.scope === 'published'
      ? await subscriptionService.findSubscribers(id).catch((err: unknown) => {
        logger.warn('Non-fatal side effect failed', { error: errorMessage(err) });
        return [];
      })
      : [];
    const deleted = await super.delete(id, orgId, userId);
    if (deleted && existing) {
      this.recordHistory(id, orgId, 'deleted', existing, userId).catch(warnNonFatal);
      this.invalidateRulesCache(orgId).catch(warnNonFatal);
      this.triggerRuleChangeScan(orgId, existing.target, userId).catch(warnNonFatal);
      if (existing.scope === 'published') {
        this.invalidateSubscriberCaches(id).catch(warnNonFatal);
        notifyPublishedRuleChange(id, existing.name, 'deleted', subscribers).catch(warnNonFatal);
      }
    }
    return deleted;
  }

  /**
   * Restore mirrors delete's correctness-critical side-effects: a restored rule
   * re-enters evaluation, so the rules cache MUST be invalidated (and subscriber
   * caches for a published rule) or the rule stays invisible until TTL. Also
   * records history and re-triggers a target scan. Called by the base
   * `restore()` after the row is un-tombstoned.
   */
  protected async onAfterRestore(id: string, entity: ComplianceRule, userId: string): Promise<void> {
    this.recordHistory(id, entity.orgId, 'restored', null, userId).catch(warnNonFatal);
    this.invalidateRulesCache(entity.orgId).catch(warnNonFatal);
    this.triggerRuleChangeScan(entity.orgId, entity.target, userId).catch(warnNonFatal);
    if (entity.scope === 'published') {
      this.invalidateSubscriberCaches(id).catch(warnNonFatal);
    }
  }
}

export const complianceRuleService = new ComplianceRuleService();
