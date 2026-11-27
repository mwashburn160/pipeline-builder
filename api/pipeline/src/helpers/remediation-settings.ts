// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org side of a pipeline's "plugin security fixes" election (nightly CVE
 * remediation, Stage 3): the root org's `pluginRemediation.rollout` and
 * `allowPipelineApply`, and a team's own `rollout` (default `inherit`), read
 * from `plugin_remediation_settings` (the plugin service writes it).
 *
 * The table is own-org only under RLS and a team's effective values need its
 * ROOT's row, so the read is sysadmin-scoped with the explicit org ids — the
 * same elevated, id-scoped read the contract check makes of the ecosystem
 * tables. A failed read falls back to the defaults (propose, apply allowed):
 * the defaults never move a pipeline by themselves.
 */

import {
  createLogger,
  errorMessage,
  normalizePluginRemediationSettings,
  pipelineElectionAllowed,
  resolveRemediationRollout,
  type PipelineRemediationElection,
  type PluginRemediationSettingsRowLike,
  type PluginRemediationRollout,
  type ResolvedRemediationRollout,
  type TeamRemediationRollout,
} from '@pipeline-builder/api-core';
import { runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { inArray } from 'drizzle-orm';
import { config } from '../config.js';

const logger = createLogger('remediation-settings');

/** The org side of the resolution, for one pipeline's org. */
export interface OrgRolloutSettings {
  /** The root org's rollout (never `inherit`). */
  root: PluginRemediationRollout;
  /** The team's own rollout when the pipeline's org IS a team; null for a root org. */
  team: TeamRemediationRollout | null;
  /** The root's `allowPipelineApply`. */
  allowPipelineApply: boolean;
  /** What a pipeline on `inherit` follows: the team's own value, else the root's. */
  orgDefault: PluginRemediationRollout;
}

/**
 * The rollout settings of `orgId`; `rootOrgId` set (and different) when
 * `orgId` is a team. Memoize per tick with {@link settingsReader}.
 */
export async function readOrgRolloutSettings(orgId: string, rootOrgId?: string | null): Promise<OrgRolloutSettings> {
  const isTeam = !!rootOrgId && rootOrgId.toLowerCase() !== orgId.toLowerCase();
  const ids = isTeam ? [orgId, rootOrgId!] : [orgId];
  let rows: Array<PluginRemediationSettingsRowLike & { orgId: string }> = [];
  try {
    rows = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => tx
      .select()
      .from(schema.pluginRemediationSetting)
      .where(inArray(schema.pluginRemediationSetting.orgId, ids)))) as typeof rows;
  } catch (err) {
    logger.warn('Remediation settings unreadable; using the defaults', { orgId, error: errorMessage(err) });
  }
  const rowOf = (id: string) => rows.find((r) => r.orgId.toLowerCase() === id.toLowerCase()) ?? null;
  const root = normalizePluginRemediationSettings(rowOf(isTeam ? rootOrgId! : orgId), { isTeam: false });
  const rootRollout = (root.rollout === 'inherit' ? 'propose' : root.rollout) as PluginRemediationRollout;
  const team = isTeam ? normalizePluginRemediationSettings(rowOf(orgId), { isTeam: true }).rollout : null;
  return {
    root: rootRollout,
    team,
    allowPipelineApply: root.allowPipelineApply,
    orgDefault: team && team !== 'inherit' ? team : rootRollout,
  };
}

/** A per-tick memo over {@link readOrgRolloutSettings}, keyed by (org, root). */
export function settingsReader(read: typeof readOrgRolloutSettings = readOrgRolloutSettings) {
  const memo = new Map<string, Promise<OrgRolloutSettings>>();
  return (orgId: string, rootOrgId?: string | null): Promise<OrgRolloutSettings> => {
    const key = `${orgId.toLowerCase()}|${(rootOrgId ?? '').toLowerCase()}`;
    let hit = memo.get(key);
    if (!hit) { hit = read(orgId, rootOrgId); memo.set(key, hit); }
    return hit;
  };
}

/** A pipeline's effective mode under its org's settings (api-core's resolution rule). */
export function effectiveRollout(election: PipelineRemediationElection, settings: OrgRolloutSettings): ResolvedRemediationRollout {
  return resolveRemediationRollout({
    pipeline: election,
    team: settings.team,
    root: settings.root,
    allowPipelineApply: settings.allowPipelineApply,
  });
}

/**
 * Why a pipeline of `orgId` may not store `election`, or null when it may: only
 * `apply` is ever refused — when the org default isn't apply and the root org
 * disallows pipeline apply (`pluginRemediation.allowPipelineApply`).
 */
export async function electionRefusal(election: PipelineRemediationElection, orgId: string, parentOrgId?: string | null): Promise<string | null> {
  const settings = await readOrgRolloutSettings(orgId, parentOrgId ?? null);
  if (pipelineElectionAllowed(election, settings.orgDefault, settings.allowPipelineApply)) return null;
  return `Your organization does not allow pipelines to choose Apply for plugin security fixes (its default is ${settings.orgDefault}). Choose Follow organization, Off or Propose.`;
}

/**
 * The deployment's remediation knob (`PLUGIN_REMEDIATION_ENABLED`; only the
 * literal `false` turns it off). Off: no rollout moves anything, and the
 * pipeline page shows "turned off by the operator".
 */
export function remediationEnabled(): boolean {
  return config.remediation.enabled;
}
