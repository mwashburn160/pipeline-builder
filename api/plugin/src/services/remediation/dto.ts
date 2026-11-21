// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { PluginRemediationDto, RemediationRolloutStart, RemediationRolloutSummary } from '@pipeline-builder/api-core';
import type { PluginRemediation } from '@pipeline-builder/pipeline-data';

/** The wire shape (the rolled-back pipeline ids included: the remediation card lists them). */
export type RemediationDtoOut = PluginRemediationDto;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** The start bookkeeping a `published` row keeps in its `rollout` jsonb (beside a summary once one exists). */
export interface StoredRolloutStart { startAttempts?: number; lastStartStatus?: string | null }

/** The rollout start bookkeeping of a row's `rollout` jsonb (null when no start failed). */
export function readRolloutStart(rollout: unknown): RemediationRolloutStart | null {
  const r = rollout as StoredRolloutStart | null | undefined;
  if (!r || typeof r.startAttempts !== 'number') return null;
  return { attempts: r.startAttempts, lastStatus: typeof r.lastStartStatus === 'string' ? r.lastStartStatus : null };
}

/** The `rollout` jsonb without the start bookkeeping (null when nothing else is left). */
export function withoutRolloutStart(rollout: unknown): Record<string, unknown> | null {
  if (!rollout || typeof rollout !== 'object') return null;
  const { startAttempts: _a, lastStartStatus: _s, ...rest } = rollout as Record<string, unknown>;
  return Object.keys(rest).length > 0 ? rest : null;
}

/** The pipeline service's summary, as the card shows it: only once a report stored one (`status`). */
function rolloutSummary(rollout: unknown): RemediationRolloutSummary | null {
  const rest = withoutRolloutStart(rollout);
  if (!rest || typeof rest.status !== 'string') return null;
  const { rolledBackPipelineIds: _r, ...summary } = rest;
  return summary as unknown as RemediationRolloutSummary;
}

/**
 * A remediation as the routes answer it. Never the findings hash, never a
 * storage key (only whether a patch / export is stored), never source or logs.
 */
export function toRemediationDto(r: PluginRemediation): RemediationDtoOut {
  const rollout = r.rollout ?? null;
  const rolledBack = (rollout as { rolledBackPipelineIds?: unknown } | null)?.rolledBackPipelineIds;
  return {
    id: r.id,
    pluginId: r.pluginId,
    pluginName: r.pluginName,
    fromVersion: r.fromVersion,
    stage: r.stage,
    outcome: r.outcome ?? null,
    toVersion: r.toVersion ?? null,
    toPluginId: r.toPluginId ?? null,
    versionBump: r.versionBump ?? null,
    upgradeLevel: r.upgradeLevel ?? null,
    publishMode: r.publishMode ?? null,
    proposeReasons: r.proposeReasons ?? [],
    fixMethods: r.fixMethods ?? [],
    targetedCount: (r.targeted ?? []).length,
    cleared: r.cleared ?? [],
    remaining: r.remaining ?? [],
    hasPatch: !!r.patchKey,
    hasExport: !!r.exportKey,
    rollout: rolloutSummary(rollout),
    rolloutStart: readRolloutStart(rollout),
    error: r.error ?? null,
    attempt: r.attempt,
    retryOf: r.retryOf ?? null,
    decidedBy: r.decidedBy ?? null,
    decidedAt: iso(r.decidedAt),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    publishedAt: iso(r.publishedAt),
    finishedAt: iso(r.finishedAt),
    rolledBackPipelineIds: Array.isArray(rolledBack) ? rolledBack.filter((x): x is string => typeof x === 'string') : [],
  };
}
