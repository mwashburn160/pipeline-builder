// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One plugin's retention plan — its facts read elevated, the declared-resolution
 * refresh, the delete path's own blockers, and the decision (select.ts) — and
 * the JSON report the dry run and the on-demand run answer with.
 */

import { SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import {
  executeRows, OFFICIAL_PUBLISHER_HANDLE, runWithTenantContext, withTenantTx,
  type PluginListing, type Publisher,
} from '@pipeline-builder/pipeline-data';
import { sql } from 'drizzle-orm';

import type { RetentionConfig } from './config.js';
import {
  declaredWithoutResolution, decidePlugin, installFacts, listedVersions, officialListing, versionFacts,
  type InstallFacts, type ListedVersionRow, type PluginDecision, type RetentionState, type VersionFacts,
} from './select.js';
import { refreshDeclaredResolutions } from '../declared-resolution-refresh.js';
import { installingOrgs } from '../ecosystem/install-notify.js';
import { listings, plugins, publishers } from '../ecosystem/store.js';
import { pluginService } from '../plugin-service.js';

/** The cap the retention pass gives the declared-resolution refresh: effectively every pipeline; a hit fails the plugin closed. */
export const REFRESH_ALL = 100_000;

/**
 * The one reason a plugin is refused for a pass: the declared-resolution
 * refresh failed or hit its cap, so the resolution rows cannot be trusted.
 */
export const REFRESH_INCOMPLETE = 'resolution_refresh_incomplete';

/** A transaction `executeRows` accepts. */
type Tx = Parameters<Parameters<typeof withTenantTx>[0]>[0];

/** One elevated read (every org's rows count). */
export function elevatedRead<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runWithTenantContext({ orgId: SYSTEM_ORG_ID, isSuperAdmin: true }, () => withTenantTx(fn));
}

/** One plugin's plan. */
export interface PluginPlan {
  name: string;
  listing: { listing: PluginListing; publisher: Publisher } | null;
  facts: VersionFacts[];
  decision: PluginDecision;
}

const ACTIVE: ReadonlySet<RetentionState> = new Set(['deprecate', 'notice', 'yank']);

async function readFacts(name: string): Promise<{ listingId: string | null; facts: VersionFacts[]; installs: InstallFacts[]; listed: ListedVersionRow[] }> {
  return elevatedRead(async (tx) => {
    const l = await officialListing(tx, name);
    const listingId = l?.id ?? null;
    return { listingId, facts: await versionFacts(tx, name, listingId), installs: await installFacts(tx, listingId), listed: await listedVersions(tx, listingId) };
  });
}

/**
 * Plan one plugin. When any version is a candidate, the declared resolutions of
 * every pipeline naming it are refreshed first (`refresh`; the read-only
 * measurement skips it), the facts are read again, and each candidate goes
 * through the delete path's own blockers (a pending publish request, any
 * pipeline the delete would refuse for) — so a version the yank stage could not
 * delete is never deprecated in the first place.
 */
export async function planPlugin(name: string, cfg: RetentionConfig, now: Date, opts: { refresh: boolean }): Promise<PluginPlan> {
  let read = await readFacts(name);
  const decide = (holdAll: string | null) => decidePlugin({
    versions: read.facts,
    installs: read.installs,
    listed: read.listed,
    keep: cfg.keep,
    noticeDays: cfg.noticeDays,
    maxFraction: cfg.maxFraction,
    now,
    holdAll,
  });
  let decision = decide(null);
  let refusal: string | null = null;

  if (decision.decisions.some((d) => ACTIVE.has(d.state) || d.state === 'refused')) {
    if (opts.refresh) {
      const outcomes = [
        await refreshDeclaredResolutions({ pluginName: name, publisher: OFFICIAL_PUBLISHER_HANDLE }, { max: REFRESH_ALL }),
        await refreshDeclaredResolutions({ pluginName: name, orgId: SYSTEM_ORG_ID }, { max: REFRESH_ALL }),
      ];
      if (outcomes.some((o) => o.failed !== 0 || o.truncated)) refusal = REFRESH_INCOMPLETE;
      read = await readFacts(name);
    }
    const holdAll = (await elevatedRead((tx) => declaredWithoutResolution(tx, name))) > 0 ? 'declared_without_resolution' : null;
    decision = decide(holdAll);
    // The delete path's own blockers, for every version the pass would act on.
    for (const d of decision.decisions) {
      if (!ACTIVE.has(d.state) && d.state !== 'refused') continue;
      const fact = read.facts.find((f) => f.pluginId === d.pluginId)!;
      const row = await plugins.byId(d.pluginId, SYSTEM_ORG_ID);
      if (!row) continue;
      const blockers = await pluginService.deleteBlockers(row, SYSTEM_ORG_ID);
      if (blockers.frozen) fact.held = 'publish_request_pending';
      else if (blockers.inUse > 0) fact.held = 'pipeline_reference';
    }
    decision = decide(holdAll);
  }

  if (refusal) {
    decision.refusedReason = refusal;
    for (const d of decision.decisions) {
      if (d.state !== 'keep') d.state = 'refused';
      delete d.deferred;
    }
    decision.deferredCount = 0;
  }

  let listing: PluginPlan['listing'] = null;
  if (read.listingId) {
    const l = await listings.byId(read.listingId);
    const p = l ? await publishers.byId(l.publisherId) : null;
    if (l && p) listing = { listing: l, publisher: p };
  }
  return { name, listing, facts: read.facts, decision };
}

/** The orgs one version's retirement would notify: its users and, when listed, the installers its install reaches. Best effort. */
export async function orgsToNotify(plan: PluginPlan, pluginId: string, version: string): Promise<string[]> {
  const orgs = new Set<string>();
  try {
    for (const o of await pluginService.findOrgsUsingVersion({ id: pluginId, orgId: SYSTEM_ORG_ID, name: plan.name, version, isDefault: false, visibility: 'public' })) orgs.add(o.toLowerCase());
  } catch { /* the notice is a courtesy */ }
  if (plan.listing) {
    try {
      for (const o of await installingOrgs(plan.listing.publisher, plan.listing.listing, version)) orgs.add(o.orgId.toLowerCase());
    } catch { /* as above */ }
  }
  return [...orgs].sort();
}

/** The version a pipeline on `version` should move to: the newest kept, non-yanked version of the same major, else the newest kept one. */
export function moveTarget(plan: PluginPlan, version: string): string | null {
  const kept = plan.decision.decisions.filter((d) => (d.state === 'keep' || d.state === 'reverse') && d.rule !== 'already_yanked');
  const major = version.split('.')[0];
  return kept.find((d) => d.version.split('.')[0] === major)?.version ?? kept[0]?.version ?? null;
}

// -----------------------------------------------------------------------------
// The report
// -----------------------------------------------------------------------------

/** What the run did with one version (absent in a dry run). */
export type RetentionAction = 'deprecated' | 'yanked' | 'reversed' | 'deferred' | 'skipped' | 'failed';

export interface RetentionVersionEntry {
  version: string;
  digest: string | null;
  state: RetentionState;
  /** Why it is kept, refused, or retirable. */
  rule: string;
  /** When the retention pass deprecated it (ISO). */
  deprecatedAt?: string;
  /** When its notice period ends (ISO). */
  yankAfter?: string;
  /** A `deprecate` the per-plugin throttle held back to a later pass. */
  deferred?: boolean;
  /** Orgs a deprecate / yank of this version notifies (deprecate and yank states only). */
  notifyOrgIds?: string[];
  /** Bytes freed once every copy of this version is gone; null when image-registry could not measure. */
  marginalBytes: number | null;
  /** The run's action (POST /plugins/retention/run only). */
  action?: RetentionAction;
  /** Why the action failed or was skipped. */
  error?: string;
}

export interface RetentionPluginEntry {
  name: string;
  listed: boolean;
  versions: RetentionVersionEntry[];
  /** Sum of the retirable versions' marginal bytes; null when not measured. */
  marginalBytes: number | null;
  /** `resolution_refresh_incomplete` when the plugin was refused this pass (its versions are `refused`). */
  refusedReason?: typeof REFRESH_INCOMPLETE;
}

/** One retired version's `system/<name>` copy handed to image-registry (run only). */
export interface RetentionCollection {
  name: string;
  version: string;
  digest: string | null;
  outcome: 'collected' | 'already_gone' | 'held' | 'refused_by_registry' | 'failed';
  rule?: string;
  error?: string;
}

export interface RetentionReport {
  generatedAt: string;
  enabled: boolean;
  dryRun: boolean;
  keep: number;
  noticeDays: number;
  batch: number;
  maxFraction: number;
  plugins: RetentionPluginEntry[];
  /** Retired versions whose images were handed over this pass (empty in a dry run). */
  collected: RetentionCollection[];
  totals: {
    /** Versions retirable now: deprecate + notice + yank. */
    retirable: number;
    deprecate: number;
    notice: number;
    yank: number;
    reverse: number;
    /** Versions in a refused plugin (`resolution_refresh_incomplete`). */
    refused: number;
    /** Plugins refused because their declared-resolution refresh did not finish. */
    refusedPlugins: number;
    /** `deprecate` versions the per-plugin throttle deferred to a later pass. */
    deferred: number;
    /** Sum over retirable versions; null when image-registry could not measure. */
    marginalBytes: number | null;
    /** Yanked + purged retirements whose system image is not collected yet. */
    awaitingCollection: number;
    /** Yanked retirements whose tombstone is past its purge deadline but the purge guard keeps refusing. */
    stuck: number;
  };
  /** Whether image-registry's byte figures cover everything. */
  storage: { measured: boolean; incomplete: boolean };
}

/** Retirement bookkeeping counts for the report and the gauges. */
export async function retirementCounts(now: Date): Promise<{ awaitingCollection: number; stuck: number }> {
  return elevatedRead(async (tx) => {
    const [row] = await executeRows<{ awaiting: number | string; stuck: number | string }>(tx, sql`
      SELECT
        count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM plugins p WHERE p.id = r.plugin_id))::int AS awaiting,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM plugins p WHERE p.id = r.plugin_id AND p.deleted_at IS NOT NULL AND p.purge_after < ${now}))::int AS stuck
        FROM plugin_retirements r
       WHERE r.yanked_at IS NOT NULL AND r.collected_at IS NULL`);
    return { awaitingCollection: Number(row?.awaiting ?? 0), stuck: Number(row?.stuck ?? 0) };
  });
}

/** Assemble the report from the plans (and, in a run, the actions taken). */
export function buildReport(input: {
  plans: readonly PluginPlan[];
  cfg: RetentionConfig;
  now: Date;
  dryRun: boolean;
  bytes: Map<string, number> | null;
  storageIncomplete: boolean;
  notify: Map<string, string[]>;
  actions: Map<string, { action: RetentionAction; error?: string }>;
  collected: RetentionCollection[];
  counts: { awaitingCollection: number; stuck: number };
}): RetentionReport {
  const totals = { retirable: 0, deprecate: 0, notice: 0, yank: 0, reverse: 0, refused: 0, refusedPlugins: 0, deferred: 0, marginalBytes: input.bytes ? 0 : null as number | null, ...input.counts };
  const pluginEntries: RetentionPluginEntry[] = input.plans.map((plan) => {
    let pluginBytes: number | null = input.bytes ? 0 : null;
    const versions = plan.decision.decisions.map((d): RetentionVersionEntry => {
      const marginal = input.bytes ? input.bytes.get(`${plan.name}@${d.version}`) ?? 0 : null;
      if (d.state !== 'keep') totals[d.state]++;
      if (d.deferred) totals.deferred++;
      if (ACTIVE.has(d.state)) {
        totals.retirable++;
        if (marginal !== null && pluginBytes !== null) pluginBytes += marginal;
      }
      const act = input.actions.get(d.pluginId);
      const orgs = input.notify.get(d.pluginId);
      return {
        version: d.version,
        digest: d.digest,
        state: d.state,
        rule: d.rule,
        ...(d.deferred ? { deferred: true } : {}),
        ...(d.deprecatedAt ? { deprecatedAt: d.deprecatedAt.toISOString() } : {}),
        ...(d.yankAfter ? { yankAfter: d.yankAfter.toISOString() } : {}),
        ...(orgs ? { notifyOrgIds: orgs } : {}),
        marginalBytes: marginal,
        ...(act ? { action: act.action, ...(act.error ? { error: act.error } : {}) } : {}),
      };
    });
    if (plan.decision.refusedReason) totals.refusedPlugins++;
    if (pluginBytes !== null && totals.marginalBytes !== null) totals.marginalBytes += pluginBytes;
    return {
      name: plan.name,
      listed: plan.listing !== null,
      versions,
      marginalBytes: pluginBytes,
      ...(plan.decision.refusedReason ? { refusedReason: plan.decision.refusedReason as typeof REFRESH_INCOMPLETE } : {}),
    };
  });
  return {
    generatedAt: input.now.toISOString(),
    enabled: input.cfg.enabled,
    dryRun: input.dryRun,
    keep: input.cfg.keep,
    noticeDays: input.cfg.noticeDays,
    batch: input.cfg.batch,
    maxFraction: input.cfg.maxFraction,
    plugins: pluginEntries,
    collected: input.collected,
    totals,
    storage: { measured: input.bytes !== null, incomplete: input.storageIncomplete },
  };
}
