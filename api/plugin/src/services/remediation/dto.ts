// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { PluginRemediationDto } from '@pipeline-builder/api-core';
import type { PluginRemediation } from '@pipeline-builder/pipeline-data';

/** The wire shape (the rolled-back pipeline ids included: the remediation card lists them). */
export type RemediationDtoOut = PluginRemediationDto;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

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
    rollout: rollout ? (({ rolledBackPipelineIds: _r, ...summary }) => summary)(rollout as typeof rollout & { rolledBackPipelineIds?: unknown }) : null,
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
