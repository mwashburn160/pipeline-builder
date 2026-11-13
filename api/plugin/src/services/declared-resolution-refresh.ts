// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Keeping the DECLARED side (`pipeline_plugin_resolution` + the declared
 * exposures) true when the catalog moves under a pipeline that did not change.
 *
 * The pipeline service records what each step resolves to when the pipeline is
 * SAVED. A range pin (`^2.0.0`, the default) then resolves to something else the
 * moment a version is published, yanked, unyanked, deleted or demoted — and until
 * the next save the reports, the exposures and the notices kept describing the
 * old answer. This re-resolves the affected pipelines the way `/plugins/lookup`
 * does (own org → its root's rows → the listing through the install) and writes
 * only the ones whose answer changed.
 *
 * Bounded (`PLUGIN_RESOLUTION_REFRESH_MAX` pipelines per trigger, oldest
 * computation first — the next trigger or the next save picks up the rest), run
 * elevated (the trigger is one org's or the system org's action; the pipelines
 * are every org's that declare the plugin), and it NEVER fails the action that
 * triggered it: every error is caught, logged and counted.
 */

import {
  createLogger, envInt, errorMessage, isManagedToolchainPlugin, managedRefPinsVersion, PluginFilterSchema, toolchainReleasePin, type ManagedToolchainPlugin,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { collectPluginSteps, pluginLookupFilter } from '@pipeline-builder/pipeline-core';
import {
  declaredPipelinesForPlugin, declaredResolution, reconcilePipelineExposures, replacePipelineResolution, resolveListingReference,
  resolveManagedToolchainHalf, runWithTenantContext, type DeclaredStepResolution, type PluginFilter,
} from '@pipeline-builder/pipeline-data';

import { listingSource } from './ecosystem/installs-store.js';
import { pluginService } from './plugin-service.js';

const logger = createLogger('declared-resolution-refresh');

/** `PLUGIN_RESOLUTION_REFRESH_MAX` (default 500): pipelines re-resolved per trigger. */
export function resolutionRefreshMax(): number {
  return envInt('PLUGIN_RESOLUTION_REFRESH_MAX', 500, { min: 1 });
}

/** Whose plugin moved: a listing (by publisher handle) or an org's own plugin. */
export type RefreshTarget = { pluginName: string; publisher: string } | { pluginName: string; orgId: string };

/**
 * A managed toolchain step (pipeline-bootstrap, cdk-synth) the way `/plugins/lookup`
 * answers it: the toolchain resolver, with the pipeline's release pin — never a
 * row or listing of the same name.
 */
async function resolveManagedAsLookup(name: ManagedToolchainPlugin, rowFilter: Partial<PluginFilter>, orgId: string, releasePin?: string): Promise<DeclaredStepResolution> {
  if (managedRefPinsVersion(rowFilter)) {
    return { refusal: { code: 'PLUGIN_UNAVAILABLE', reason: 'pin_via_release', message: `${name} can't be pinned on its own; pin the release with toolchain.release.` } };
  }
  const res = await resolveManagedToolchainHalf({ orgId }, name, releasePin ? { releasePin } : {});
  if ('refusal' in res) return { refusal: res.refusal };
  const row = res.plugin;
  return {
    plugin: {
      id: row.id,
      publisher: null,
      name: row.name,
      version: row.version,
      imageDigest: row.imageDigest ?? null,
      scan: { imageDigest: row.imageDigest ?? null, scanSummary: row.scanSummary, scanFlag: row.scanFlag, scanFlaggedAt: row.scanFlaggedAt },
    },
  };
}

/** Resolve one step filter for an org the way `/plugins/lookup` does (no warnings, no verification). */
async function resolveAsLookup(filter: Record<string, unknown>, orgId: string, rootOrgId: string | null, releasePin?: string): Promise<DeclaredStepResolution> {
  const parsed = PluginFilterSchema.safeParse(filter);
  if (!parsed.success) return null;
  const { publisher, ...rowFilter } = parsed.data as Partial<PluginFilter> & { publisher?: string };
  if (typeof rowFilter.name === 'string' && isManagedToolchainPlugin(rowFilter.name)) {
    return resolveManagedAsLookup(rowFilter.name.trim().toLowerCase() as ManagedToolchainPlugin, rowFilter, orgId, releasePin);
  }
  if (!publisher) {
    const row = await pluginService.findFirst({ ...rowFilter, ...(rowFilter.name !== undefined ? { nameMatch: 'exact' as const } : {}), excludeYanked: true }, orgId, rootOrgId ?? undefined);
    if (row) {
      return {
        plugin: {
          id: row.id,
          publisher: null,
          name: row.name,
          version: row.version,
          imageDigest: row.imageDigest ?? null,
          scan: { imageDigest: row.imageDigest ?? null, scanSummary: row.scanSummary, scanFlag: row.scanFlag, scanFlaggedAt: row.scanFlaggedAt },
        },
      };
    }
  }
  if (typeof rowFilter.name !== 'string' || rowFilter.id !== undefined) return null;
  const res = await resolveListingReference(listingSource, {
    ...(publisher ? { publisher } : {}), name: rowFilter.name, ...(typeof rowFilter.version === 'string' ? { version: rowFilter.version } : {}),
  }, { orgId, ...(rootOrgId ? { rootOrgId } : {}) });
  if (!res) return null;
  if (!res.ok) return { refusal: res.refusal };
  const v = res.version;
  return {
    plugin: {
      id: v.id,
      publisher: res.publisher.handle,
      name: res.listing.name,
      version: v.version,
      imageDigest: v.imageDigest,
      scan: { imageDigest: v.imageDigest, scanSummary: v.scanSummary, scanFlag: v.scanFlag, scanFlaggedAt: v.scanFlaggedAt },
    },
  };
}

/**
 * Re-resolve the pipelines declaring `target` and rewrite the ones whose
 * resolved version or image changed. Never throws.
 */
export async function refreshDeclaredResolutions(target: RefreshTarget): Promise<{ refreshed: number; unchanged: number; truncated: boolean }> {
  const outcome = { refreshed: 0, unchanged: 0, truncated: false };
  try {
    await runWithTenantContext({ isSuperAdmin: true }, async () => {
      const { pipelines, truncated } = await declaredPipelinesForPlugin(target, resolutionRefreshMax());
      outcome.truncated = truncated;
      for (const p of pipelines) {
        try {
          const steps = collectPluginSteps(p.props).map((s) => ({
            label: s.label,
            name: s.name,
            ...(s.publisher ? { publisher: s.publisher } : {}),
            ...(s.filter ? { filter: s.filter as Record<string, unknown> } : {}),
            lookupFilter: pluginLookupFilter(s),
          }));
          const { rows, exposureSteps } = await declaredResolution({
            pipelineId: p.pipelineId,
            orgId: p.orgId,
            rootOrgId: p.rootOrgId,
            steps,
            resolve: (filter) => resolveAsLookup(filter, p.orgId, p.rootOrgId, toolchainReleasePin(p.props)),
          });
          const changed = rows.length !== p.current.size || rows.some((r) => {
            const before = p.current.get(`${r.stageName}\u0000${r.stepName}`);
            return !before || before.resolvedVersion !== (r.resolvedVersion ?? null) || before.resolvedDigest !== (r.resolvedDigest ?? null);
          });
          if (!changed) { outcome.unchanged++; continue; }
          await replacePipelineResolution(p.pipelineId, rows);
          await reconcilePipelineExposures({ orgId: p.orgId, pipelineId: p.pipelineId, source: 'declared', steps: exposureSteps });
          outcome.refreshed++;
        } catch (err) {
          logger.warn('Declared resolution of one pipeline not refreshed', { pipelineId: p.pipelineId, error: errorMessage(err) });
        }
      }
    });
    if (outcome.truncated) logger.warn('Declared resolution refresh hit its cap; the rest refresh on their next trigger or save', { ...target, max: resolutionRefreshMax() });
    incCounter('plugin_declared_resolution_refreshed_total', {}, outcome.refreshed);
  } catch (err) {
    logger.warn('Declared resolution refresh failed', { ...target, error: errorMessage(err) });
  }
  return outcome;
}
