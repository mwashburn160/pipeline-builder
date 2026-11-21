// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The fleet's remediation state for the operators' vulnerability posture
 * (`GET /plugins/vulnerabilities/fleet`'s optional `remediation` block; the
 * frontend's FleetRemediationPosture). Read elevated across every org.
 */

import { PLUGIN_REMEDIATION_STAGES, type PluginRemediationStage } from '@pipeline-builder/api-core';
import { schema } from '@pipeline-builder/pipeline-data';
import { desc, isNotNull, sql } from 'drizzle-orm';

import { canaryStatus } from './canary.js';
import { elevatedTx } from './store.js';
import { remediationConfig } from '../../config.js';

/** Canary stale after this long without an all-clean pass (the alert's threshold). */
const CANARY_STALE_MS = 48 * 3_600_000;

export interface FleetRemediationPosture {
  enabled: boolean;
  stages: Partial<Record<PluginRemediationStage, number>>;
  /** Latest remediation stage per plugin version id. */
  byVersion: Record<string, PluginRemediationStage>;
  basePass: null;
  canary: { fixtures: number; failing: string[]; lastPassAt: string | null; stale: boolean } | null;
  orphans: number;
}

export async function fleetRemediationPosture(now: Date = new Date()): Promise<FleetRemediationPosture> {
  const r = schema.pluginRemediation;
  const counts = await elevatedTx((tx) => tx.select({ stage: r.stage, n: sql<number>`count(*)::int` }).from(r).groupBy(r.stage)) as Array<{ stage: PluginRemediationStage; n: number }>;
  const stages: Partial<Record<PluginRemediationStage, number>> = {};
  for (const c of counts) if ((PLUGIN_REMEDIATION_STAGES as readonly string[]).includes(c.stage)) stages[c.stage] = Number(c.n);
  // Stored versions only: a fix record whose version was purged (plugin_id NULL) has no version to key.
  const latest = await elevatedTx((tx) => tx.selectDistinctOn([r.pluginId], { pluginId: r.pluginId, stage: r.stage })
    .from(r).where(isNotNull(r.pluginId)).orderBy(r.pluginId, desc(r.createdAt)).limit(5_000)) as Array<{ pluginId: string; stage: PluginRemediationStage }>;
  const o = schema.pluginSourceOrphan;
  const [orphans] = await elevatedTx((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(o)) as Array<{ n: number }>;
  const canary = await canaryStatus().catch(() => null);
  return {
    enabled: remediationConfig().enabled,
    stages,
    byVersion: Object.fromEntries(latest.map((l) => [l.pluginId, l.stage])),
    // The shared-base pass keeps no rows of its own (Redis markers per base and findings set).
    basePass: null,
    canary: canary ? {
      fixtures: canary.fixtures,
      failing: canary.failing,
      lastPassAt: canary.lastPassAt?.toISOString() ?? null,
      stale: !canary.lastPassAt || now.getTime() - canary.lastPassAt.getTime() > CANARY_STALE_MS,
    } : null,
    orphans: Number(orphans?.n ?? 0),
  };
}
