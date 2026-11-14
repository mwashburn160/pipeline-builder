// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RETIRING superseded system plugin versions — the action half of the
 * retention pass (select.ts decides which; plan.ts reads one plugin).
 *
 * Two stages, both through the EXISTING lifecycle services, never by writing
 * lifecycle columns directly:
 *
 *  1. DEPRECATE — `pluginService.setDeprecated` on the system row and the
 *     system org's listed-version deprecation on its Official copy. It keeps
 *     resolving; lookup and synth warn, AI selection stops offering it. A
 *     `plugin_retirements` row starts the notice period
 *     (`PLUGIN_RETENTION_NOTICE_DAYS`).
 *  2. YANK — once the notice period is over and the version is STILL
 *     retirable (the plan is re-read for the plugin and the version's hold is
 *     re-checked right before acting): the listed copy is yanked (an unlisted
 *     row is yanked on the row), then the row is soft-deleted through the
 *     normal delete path, which sets `purge_after`.
 *
 * A version that stopped being retirable during its notice has its deprecation
 * reversed (`{ deprecated: false }`, unless it was already deprecated before
 * the pass took it) and its retirement row deleted.
 *
 * Notices are GROUPED: the per-version notices of the services are suppressed
 * and every org hears once per pass (N35), with each affected version and the
 * version to move to. Every stage is audited `plugin.version.retire`
 * (`details.stage`).
 *
 * After the retention purge hard-deletes a retired row, the pass hands its
 * `system/<name>` digest to image-registry ({@link collectRetiredImages}),
 * after re-checking the reference and install rules and the declared
 * resolutions; a failed hand-over stays `collected_at IS NULL` and is retried
 * next pass.
 *
 * Safety: at most `PLUGIN_RETENTION_BATCH` versions are acted on per pass, and
 * each plugin newly deprecates at most `floor(PLUGIN_RETENTION_MAX_FRACTION ×
 * live versions)` (at least one), oldest first — the rest wait for a later pass
 * (a throttle, never counted as a failure). A plugin whose declared-resolution
 * refresh did not finish is refused for the pass and counted
 * (`plugin_retention_failed_total{stage="refused"}`), so it alerts.
 *
 * Metrics: `plugin_retention_retired_total{stage}` (deprecate | yank |
 * collect), `plugin_retention_failed_total{stage}` (select | deprecate | yank |
 * reverse | collect | notify | refused), and the gauges
 * `plugin_retention_retirable` and `plugin_retention_stuck`.
 */

import {
  createLogger, createScheduler, DEFAULT_LEADER_LOCK_TTL_MS, errorMessage, leaderLockKey, recordAudit, SYSTEM_ACTOR_ID, SYSTEM_ORG_ID,
  type LockRedis, type Scheduler,
} from '@pipeline-builder/api-core';
import { incCounter, setGauge } from '@pipeline-builder/api-server';
import { executeRows, OFFICIAL_PUBLISHER_HANDLE, runWithTenantContext, schema } from '@pipeline-builder/pipeline-data';
import { eq, sql } from 'drizzle-orm';

import { retentionConfig, type RetentionConfig } from './config.js';
import {
  buildReport, elevatedRead, moveTarget, orgsToNotify, planPlugin, REFRESH_ALL, retirementCounts,
  type PluginPlan, type RetentionAction, type RetentionCollection, type RetentionReport,
} from './plan.js';
import { declaredWithoutResolution, retentionHoldSql, systemPluginNames, type VersionDecision } from './select.js';
import { refreshDeclaredResolutions } from '../declared-resolution-refresh.js';
import { yankListedVersion } from '../ecosystem/execute.js';
import { orgApprovers } from '../ecosystem/install-notify.js';
import { gcSystemImage, RegistryPublicationError, retentionBreakdown } from '../ecosystem/registry.js';
import { plugins } from '../ecosystem/store.js';
import { systemSetListedDeprecation } from '../ecosystem/version-deprecation.js';
import { enqueueEcosystemNotification } from '../ecosystem-notifications.js';
import { pluginService } from '../plugin-service.js';

const logger = createLogger('plugin-retention');

export const RETIRED_COUNTER = 'plugin_retention_retired_total';
export const FAILED_COUNTER = 'plugin_retention_failed_total';
export const RETIRABLE_GAUGE = 'plugin_retention_retirable';
export const STUCK_GAUGE = 'plugin_retention_stuck';

/** The yank reason every retention yank carries. */
export const RETENTION_YANK_REASON = 'superseded';

const DAY = (d: Date) => d.toISOString().slice(0, 10);

function audit(stage: 'deprecate' | 'yank' | 'reverse' | 'collect', target: { pluginId: string; name: string; version: string; digest: string | null; rule: string }, extra: Record<string, unknown> = {}): void {
  recordAudit({
    action: 'plugin.version.retire',
    actorId: SYSTEM_ACTOR_ID,
    orgId: SYSTEM_ORG_ID,
    targetType: 'plugin',
    targetId: target.pluginId,
    details: { stage, pluginName: target.name, version: target.version, digest: target.digest, rule: target.rule, ...extra },
  });
}

// -----------------------------------------------------------------------------
// Grouped notices
// -----------------------------------------------------------------------------

interface NoticeLine { ref: string; stage: 'deprecated' | 'yanked'; yankAfter?: Date; moveTo: string | null }

/** Collects every org's lines during a pass; {@link send} sends ONE N35 per org. */
export class NoticeBook {
  private readonly byOrg = new Map<string, NoticeLine[]>();

  add(orgIds: readonly string[], line: NoticeLine): void {
    for (const o of orgIds) this.byOrg.set(o, [...(this.byOrg.get(o) ?? []), line]);
  }

  /** The notice one org gets. */
  static render(lines: readonly NoticeLine[]): { subject: string; text: string } {
    const body = lines.map((l) => {
      const what = l.stage === 'deprecated'
        ? `deprecated; ranges, latest and the default stop resolving to it after ${l.yankAfter ? DAY(l.yankAfter) : 'its notice period'}`
        : 'yanked; ranges, latest and the default skip it now';
      return `  • ${l.ref} — ${what}.${l.moveTo ? ` Move to ${l.moveTo}.` : ''}`;
    });
    return {
      subject: `Superseded plugin versions are being retired (${lines.length})`,
      text: [
        'The platform retires old versions of its Official plugins once newer ones replace them. These versions your organization can reach changed:',
        body.join('\n'),
        'Deployed pipelines keep pulling their pinned image, and a version a pipeline references is never retired. Move to a supported version, then re-synth.',
      ].join('\n\n').slice(0, 10_000),
    };
  }

  /** Send the notices. Never throws; returns the orgs notified. */
  async send(): Promise<number> {
    let sent = 0;
    for (const [orgId, lines] of this.byOrg) {
      try {
        await enqueueEcosystemNotification('N35', [orgApprovers(orgId)], NoticeBook.render(lines));
        sent++;
      } catch (err) {
        incCounter(FAILED_COUNTER, { stage: 'notify' });
        logger.warn('Retention notice not sent', { orgId, error: errorMessage(err) });
      }
    }
    return sent;
  }
}

// -----------------------------------------------------------------------------
// The stages
// -----------------------------------------------------------------------------

/** The hold that keeps one live system row NOW (re-read right before acting), or null. */
async function currentHold(pluginId: string): Promise<string | null> {
  const [row] = await elevatedRead((tx) => executeRows<{ held: string | null }>(tx, sql`
    SELECT ${retentionHoldSql({
      name: sql`pr.name`,
      version: sql`pr.version`,
      digest: sql`pr.image_digest`,
      publicDigest: sql`lv.image_digest`,
      isDefault: sql`pr.is_default`,
      pausedAt: sql`lv.paused_at`,
    })} AS held
      FROM plugins pr
      LEFT JOIN plugin_listings l ON l.name = pr.name AND l.publisher_id = (SELECT id FROM publishers WHERE handle = ${OFFICIAL_PUBLISHER_HANDLE})
      LEFT JOIN plugin_listing_versions lv ON lv.listing_id = l.id AND lv.version = pr.version
     WHERE pr.id = ${pluginId}::uuid`));
  return row?.held ?? null;
}

function deprecationMessage(plan: PluginPlan, d: VersionDecision, yankAfter: Date): string {
  const to = moveTarget(plan, d.version);
  return `Superseded: retired by the platform's version retention; it is yanked after ${DAY(yankAfter)}.${to ? ` Move to ${plan.name}@${to}.` : ''}`;
}

/** Stage 1. */
async function deprecate(plan: PluginPlan, d: VersionDecision, cfg: RetentionConfig, now: Date): Promise<void> {
  const row = await plugins.byId(d.pluginId, SYSTEM_ORG_ID);
  if (!row) throw new Error('the row is gone');
  const yankAfter = new Date(now.getTime() + cfg.noticeDays * 86_400_000);
  const message = deprecationMessage(plan, d, yankAfter);
  const already = row.deprecatedAt !== null;
  if (!already) await pluginService.setDeprecated(row, SYSTEM_ORG_ID, SYSTEM_ACTOR_ID, { deprecated: true, message });
  const fact = plan.facts.find((f) => f.pluginId === d.pluginId);
  if (plan.listing && fact?.listing && !fact.listing.deprecated) {
    await systemSetListedDeprecation(plan.listing.listing, plan.listing.publisher, d.version, {
      deprecated: true, message, actor: SYSTEM_ACTOR_ID, via: 'retention', notify: false,
    });
  }
  const R = schema.pluginRetirement;
  const values = {
    pluginId: d.pluginId,
    pluginName: plan.name,
    version: d.version,
    imageDigest: d.digest,
    listingVersionId: fact?.listing?.id ?? null,
    rule: d.rule,
    deprecatedByRetention: !already,
    deprecatedAt: now,
    yankedAt: null,
    collectedAt: null,
  };
  // A stale row (a version restored after an earlier retirement) is replaced.
  await elevatedRead((tx) => tx.insert(R).values(values).onConflictDoUpdate({ target: R.pluginId, set: values }));
  audit('deprecate', { pluginId: d.pluginId, name: plan.name, version: d.version, digest: d.digest, rule: d.rule }, { yankAfter: yankAfter.toISOString() });
  incCounter(RETIRED_COUNTER, { stage: 'deprecate' });
}

/** Reverse a deprecation the pass made, and forget the retirement. */
async function reverse(plan: PluginPlan, d: VersionDecision): Promise<void> {
  const R = schema.pluginRetirement;
  const [rec] = await elevatedRead((tx) => tx.select().from(R).where(eq(R.pluginId, d.pluginId)));
  if (rec?.deprecatedByRetention !== false) {
    const row = await plugins.byId(d.pluginId, SYSTEM_ORG_ID);
    if (row?.deprecatedAt) await pluginService.setDeprecated(row, SYSTEM_ORG_ID, SYSTEM_ACTOR_ID, { deprecated: false });
    const fact = plan.facts.find((f) => f.pluginId === d.pluginId);
    if (plan.listing && fact?.listing?.deprecated) {
      await systemSetListedDeprecation(plan.listing.listing, plan.listing.publisher, d.version, {
        deprecated: false, message: null, actor: SYSTEM_ACTOR_ID, via: 'retention',
      });
    }
  }
  await elevatedRead((tx) => tx.delete(R).where(eq(R.pluginId, d.pluginId)));
  audit('reverse', { pluginId: d.pluginId, name: plan.name, version: d.version, digest: d.digest, rule: d.rule });
}

/** Stage 2. */
async function yank(plan: PluginPlan, d: VersionDecision, now: Date): Promise<void> {
  const fact = plan.facts.find((f) => f.pluginId === d.pluginId);
  if (plan.listing && fact?.listing && !fact.listing.yanked) {
    await yankListedVersion(plan.listing.listing, plan.listing.publisher, d.version, RETENTION_YANK_REASON, SYSTEM_ACTOR_ID, { notify: false });
  } else if (!fact?.listing) {
    const row = await plugins.byId(d.pluginId, SYSTEM_ORG_ID);
    if (row && !row.yankedAt) await pluginService.yankVersion(row, SYSTEM_ORG_ID, SYSTEM_ACTOR_ID, RETENTION_YANK_REASON);
  }
  const fresh = await plugins.byId(d.pluginId, SYSTEM_ORG_ID);
  if (fresh) await pluginService.deleteVersion(fresh, SYSTEM_ORG_ID, SYSTEM_ACTOR_ID, { force: true });
  const R = schema.pluginRetirement;
  await elevatedRead((tx) => tx.update(R).set({ yankedAt: now }).where(eq(R.pluginId, d.pluginId)));
  audit('yank', { pluginId: d.pluginId, name: plan.name, version: d.version, digest: d.digest, rule: d.rule }, { reason: RETENTION_YANK_REASON });
  incCounter(RETIRED_COUNTER, { stage: 'yank' });
}

/**
 * Act on one plugin's plan within the pass's remaining `budget`. Returns the
 * budget left. Every failure is counted and logged; the pass moves on.
 */
async function actOn(
  plan: PluginPlan, cfg: RetentionConfig, now: Date, budget: number, book: NoticeBook,
  actions: Map<string, { action: RetentionAction; error?: string }>, notify: Map<string, string[]>,
): Promise<number> {
  if (plan.decision.refusedReason) {
    incCounter(FAILED_COUNTER, { stage: 'refused' });
    logger.warn('Plugin refused by the retention pass: its declared-resolution refresh did not finish', { plugin: plan.name, reason: plan.decision.refusedReason });
  }
  for (const d of plan.decision.decisions) {
    const target = { name: plan.name, d };
    try {
      if (d.state === 'reverse') {
        await reverse(plan, d);
        actions.set(d.pluginId, { action: 'reversed' });
        continue;
      }
      if (d.state !== 'deprecate' && d.state !== 'yank') continue;
      if (d.deferred) {
        actions.set(d.pluginId, { action: 'deferred', error: 'Per-plugin throttle (PLUGIN_RETENTION_MAX_FRACTION); a later pass deprecates it' });
        continue;
      }
      if (budget <= 0) {
        actions.set(d.pluginId, { action: 'deferred', error: 'PLUGIN_RETENTION_BATCH reached; the next pass continues' });
        continue;
      }
      // Check, then act: a deploy may have landed since the plan was read.
      const held = await currentHold(d.pluginId);
      if (held) {
        if (d.state === 'yank') {
          await reverse(plan, { ...d, rule: held });
          actions.set(d.pluginId, { action: 'reversed', error: `held by ${held}` });
        } else {
          actions.set(d.pluginId, { action: 'skipped', error: `held by ${held}` });
        }
        continue;
      }
      budget--;
      const orgs = notify.get(d.pluginId) ?? [];
      if (d.state === 'deprecate') {
        await deprecate(plan, d, cfg, now);
        actions.set(d.pluginId, { action: 'deprecated' });
        book.add(orgs, { ref: `${plan.name}@${d.version}`, stage: 'deprecated', yankAfter: new Date(now.getTime() + cfg.noticeDays * 86_400_000), moveTo: moveRef(plan, d.version) });
      } else {
        await yank(plan, d, now);
        actions.set(d.pluginId, { action: 'yanked' });
        book.add(orgs, { ref: `${plan.name}@${d.version}`, stage: 'yanked', moveTo: moveRef(plan, d.version) });
      }
    } catch (err) {
      const stage = d.state === 'reverse' ? 'reverse' : d.state;
      incCounter(FAILED_COUNTER, { stage });
      actions.set(d.pluginId, { action: 'failed', error: errorMessage(err) });
      logger.warn('Retention stage failed', { plugin: target.name, version: d.version, stage, error: errorMessage(err) });
    }
  }
  return budget;
}

function moveRef(plan: PluginPlan, version: string): string | null {
  const to = moveTarget(plan, version);
  return to ? `${plan.name}@${to}` : null;
}

// -----------------------------------------------------------------------------
// Collection of the system/<name> copy
// -----------------------------------------------------------------------------

interface CollectRow { id: string; plugin_id: string; plugin_name: string; version: string; image_digest: string | null; held: string | null; install_held: boolean; digest_in_use: boolean }

/**
 * Hand the `system/<name>` digests of retired, PURGED rows to image-registry.
 * Re-checks first, failing closed: any pipeline reference (system image or the
 * public copy), a soft-deleted pipeline's resolution or pin, a template pin, an
 * install pinned to / resolved at / asking for the version, another plugin row
 * on the same digest, or — after a declared-resolution refresh — a pipeline
 * declaring the plugin without resolution rows.
 */
export async function collectRetiredImages(opts: { now: Date; limit: number; signal?: AbortSignal }): Promise<RetentionCollection[]> {
  const rows = await elevatedRead((tx) => executeRows<CollectRow>(tx, sql`
    SELECT rt.id, rt.plugin_id, rt.plugin_name, rt.version, rt.image_digest,
           ${retentionHoldSql({
              name: sql`rt.plugin_name`,
              version: sql`rt.version`,
              digest: sql`rt.image_digest`,
              publicDigest: sql`lv.image_digest`,
              isDefault: sql`false`,
              pausedAt: sql`NULL::timestamptz`,
            })} AS held,
           EXISTS (SELECT 1 FROM plugin_installs i WHERE i.listing_id = lv.listing_id AND i.status <> 'denied'
                    AND (i.pinned_version = rt.version OR i.resolved_version = rt.version OR i.pending_change->>'version' = rt.version)) AS install_held,
           (rt.image_digest IS NOT NULL AND EXISTS (SELECT 1 FROM plugins o WHERE o.image_digest = rt.image_digest)) AS digest_in_use
      FROM plugin_retirements rt
      LEFT JOIN plugin_listing_versions lv ON lv.id = rt.listing_version_id
     WHERE rt.yanked_at IS NOT NULL AND rt.collected_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM plugins p WHERE p.id = rt.plugin_id)
     ORDER BY rt.yanked_at
     LIMIT ${opts.limit}`));
  const out: RetentionCollection[] = [];
  const refreshed = new Map<string, string | null>();
  const R = schema.pluginRetirement;
  const markCollected = (id: string) => elevatedRead((tx) => tx.update(R).set({ collectedAt: opts.now }).where(eq(R.id, id)));
  for (const r of rows) {
    if (opts.signal?.aborted) break;
    const base = { name: r.plugin_name, version: r.version, digest: r.image_digest };
    try {
      if (!r.image_digest) {
        await markCollected(r.id);
        out.push({ ...base, outcome: 'already_gone' });
        continue;
      }
      const held = r.held ?? (r.install_held ? 'install_pinned' : null) ?? (r.digest_in_use ? 'digest_shared_with_a_plugin_row' : null);
      if (held) { out.push({ ...base, outcome: 'held', rule: held }); continue; }
      if (!refreshed.has(r.plugin_name)) refreshed.set(r.plugin_name, await declaredHold(r.plugin_name));
      const declared = refreshed.get(r.plugin_name)!;
      if (declared) { out.push({ ...base, outcome: 'held', rule: declared }); continue; }
      const res = await gcSystemImage({ name: r.plugin_name, version: r.version, digest: r.image_digest, actorId: SYSTEM_ACTOR_ID });
      await markCollected(r.id);
      audit('collect', { pluginId: r.plugin_id, name: r.plugin_name, version: r.version, digest: r.image_digest, rule: 'purged' }, { deleted: res.deleted });
      incCounter(RETIRED_COUNTER, { stage: 'collect' });
      out.push({ ...base, outcome: res.deleted ? 'collected' : 'already_gone' });
    } catch (err) {
      const refused = err instanceof RegistryPublicationError && err.status === 409;
      incCounter(FAILED_COUNTER, { stage: 'collect' });
      logger[refused ? 'info' : 'warn']('Retired system image not collected', { ...base, error: errorMessage(err) });
      out.push({ ...base, outcome: refused ? 'refused_by_registry' : 'failed', error: errorMessage(err) });
    }
  }
  return out;
}

/** The declared-resolution rule for a plugin with no live rows left: refresh, then any pipeline declaring it without rows holds it. */
async function declaredHold(name: string): Promise<string | null> {
  const outcomes = [
    await refreshDeclaredResolutions({ pluginName: name, publisher: OFFICIAL_PUBLISHER_HANDLE }, { max: REFRESH_ALL }),
    await refreshDeclaredResolutions({ pluginName: name, orgId: SYSTEM_ORG_ID }, { max: REFRESH_ALL }),
  ];
  if (outcomes.some((o) => o.failed !== 0 || o.truncated)) return 'resolution_refresh_incomplete';
  return (await elevatedRead((tx) => declaredWithoutResolution(tx, name))) > 0 ? 'declared_without_resolution' : null;
}

// -----------------------------------------------------------------------------
// The pass
// -----------------------------------------------------------------------------

/**
 * One retention pass over every system plugin. `dryRun` (the plan route, the
 * measurement) decides and reports without acting; `refresh: false` also skips
 * the declared-resolution refresh, making it strictly read-only.
 */
export async function runRetentionPass(opts: { dryRun: boolean; refresh?: boolean; now?: Date; signal?: AbortSignal } = { dryRun: true }): Promise<RetentionReport> {
  const cfg = retentionConfig();
  const now = opts.now ?? new Date();
  return runWithTenantContext({ orgId: SYSTEM_ORG_ID, isSuperAdmin: true }, async () => {
    const names = await elevatedRead((tx) => systemPluginNames(tx));
    const breakdown = await retentionBreakdown();
    const bytes = breakdown ? new Map(breakdown.entries.map((e) => [`${e.name}@${e.version}`, e.marginalBytes])) : null;
    const plans: PluginPlan[] = [];
    const notify = new Map<string, string[]>();
    const actions = new Map<string, { action: RetentionAction; error?: string }>();
    const book = new NoticeBook();
    let budget = cfg.batch;
    let failedPlans = 0;
    for (const name of names) {
      if (opts.signal?.aborted) break;
      let plan: PluginPlan;
      try {
        plan = await planPlugin(name, cfg, now, { refresh: opts.refresh ?? true });
      } catch (err) {
        failedPlans++;
        incCounter(FAILED_COUNTER, { stage: 'select' });
        logger.warn('Retention plan failed; the plugin is skipped this pass', { plugin: name, error: errorMessage(err) });
        continue;
      }
      for (const d of plan.decision.decisions) {
        if ((d.state === 'deprecate' && !d.deferred) || d.state === 'yank') notify.set(d.pluginId, await orgsToNotify(plan, d.pluginId, d.version));
      }
      if (!opts.dryRun) budget = await actOn(plan, cfg, now, budget, book, actions, notify);
      plans.push(plan);
    }
    const collected = opts.dryRun ? [] : await collectRetiredImages({ now, limit: cfg.batch, signal: opts.signal });
    if (!opts.dryRun) await book.send();
    const report = buildReport({
      plans,
      cfg,
      now,
      dryRun: opts.dryRun,
      bytes,
      storageIncomplete: breakdown?.incomplete ?? false,
      notify,
      actions,
      collected,
      counts: await retirementCounts(now),
    });
    setGauge(RETIRABLE_GAUGE, {}, report.totals.retirable);
    setGauge(STUCK_GAUGE, {}, report.totals.stuck);
    logger.info('Retention pass complete', { dryRun: opts.dryRun, plugins: plans.length, ...report.totals });
    // Every plugin failed to plan: the database is down. A throw keeps the
    // scheduler from stamping a success, so SchedulerJobStale fires.
    if (names.length > 0 && failedPlans === names.length) throw new Error(`Retention pass: every plugin failed to plan (${failedPlans})`);
    return report;
  });
}

/** Build (not start) the daily scheduler, leader-locked on the shared Redis. Only created when `PLUGIN_RETENTION_ENABLED`. */
export function createRetentionScheduler(redis: () => LockRedis): Scheduler {
  return createScheduler({
    name: 'plugin-superseded-retention',
    intervalMs: 24 * 60 * 60_000,
    startupDelayMs: 5 * 60_000,
    lock: { redis, key: leaderLockKey('plugin', 'superseded-retention'), ttlMs: DEFAULT_LEADER_LOCK_TTL_MS },
    run: async (lease?: { signal?: AbortSignal }) => {
      if (!retentionConfig().enabled) return;
      await runRetentionPass({ dryRun: false, signal: lease?.signal });
    },
  });
}
