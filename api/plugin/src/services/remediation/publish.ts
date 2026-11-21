// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Publishing a verified fix as the next free version (plan step 4): stored
 * through the same success tail as any build (`persistVersion` — the default
 * rule, the report refresh), with provenance (the version it fixes and the
 * advisories it clears in its changelog, the remediation row linking both), its
 * own kept source (a copy of the patched ZIP, so the next remediation starts
 * from it), no `plugins` quota slot (`quota_reset_at` NULL — nothing to refund
 * either), then the Official listing fix or the tenant rollout.
 *
 * The remediation's diff (and an Official fix's export) is kept under the FIX
 * version's prefix too (`<orgId>/<toPluginId>/<toVersion>/remediations/<id>/`),
 * and `patch_key` / `export_key` point at those copies: the from-version is
 * superseded by its fix and is the one tidying and retention purge first, and
 * its purge deletes its whole prefix — the diff must not go with it while the
 * fix version it explains is still live.
 */

import { createHash } from 'crypto';

import {
  ACTIVE_BUILD_REMEDIATION_STAGES,
  createLogger,
  isSystemOrgId,
  errorMessage,
  pluginSourceKey,
  remediationDiffKey,
  SYSTEM_PLUGIN_REMEDIATION,
  type PluginSmokeTest,
} from '@pipeline-builder/api-core';
import type { Plugin, PluginRemediation } from '@pipeline-builder/pipeline-data';

import type { EngineCandidate } from './engine.js';
import { auditRemediation, countCleared, countStage, advisoryIds } from './lifecycle.js';
import { recordRolloutStart } from './rollout-start.js';
import { startTenantRollout } from './rollout.js';
import { getRemediation, updateRemediation } from './store.js';
import type { PluginRecordData } from '../../helpers/plugin-helpers.js';
import { openOfficialListingFix, storeOfficialExport } from '../ecosystem/remediation-fixes.js';
import { putRemediationArtifact, recordVersionSource } from '../plugin-sources.js';
import { sendRemediationNotice } from '../remediation-notices.js';
import { persistVersion } from '../version-persist.js';

const logger = createLogger('plugin-remediation-publish');

/** The smokeTest command a stored `smoke_test` carries ('' for none). */
export function smokeCommand(s: PluginSmokeTest | null | undefined): string {
  if (typeof s === 'string') return s.trim();
  const c = s && typeof s === 'object' ? (s as { command?: unknown }).command : undefined;
  return typeof c === 'string' ? c.trim() : '';
}

/** A stored version's record, as a build job would carry it. */
export function recordFromRow(p: Plugin): PluginRecordData {
  const smoke = smokeCommand(p.smokeTest as PluginSmokeTest | null);
  return {
    orgId: p.orgId,
    name: p.name,
    description: p.description ?? null,
    version: p.version,
    category: p.category,
    metadata: (p.metadata ?? {}) as PluginRecordData['metadata'],
    pluginType: p.pluginType as PluginRecordData['pluginType'],
    computeType: p.computeType as PluginRecordData['computeType'],
    primaryOutputDirectory: p.primaryOutputDirectory ?? null,
    dockerfile: p.dockerfile ?? null,
    env: (p.env ?? {}) as Record<string, string>,
    buildArgs: (p.buildArgs ?? {}) as Record<string, string>,
    keywords: (p.keywords ?? []) as string[],
    installCommands: (p.installCommands ?? []) as string[],
    commands: (p.commands ?? []) as string[],
    visibility: p.visibility as PluginRecordData['visibility'],
    timeout: p.timeout ?? null,
    failureBehavior: (p.failureBehavior ?? 'fail') as PluginRecordData['failureBehavior'],
    buildType: p.buildType as PluginRecordData['buildType'],
    secrets: (p.secrets ?? []) as PluginRecordData['secrets'],
    requiredMetadata: (p.requiredMetadata ?? []) as string[],
    requiredVars: (p.requiredVars ?? []) as string[],
    metadataTypes: (p.metadataTypes ?? {}) as PluginRecordData['metadataTypes'],
    varsTypes: (p.varsTypes ?? {}) as PluginRecordData['varsTypes'],
    smokeTest: smoke === '' ? null : smoke,
    networkEgress: (p.networkEgress ?? []) as string[],
    summary: p.summary ?? null,
    displayName: p.displayName ?? null,
    readmeMd: p.readmeMd ?? null,
    readmeHtml: p.readmeHtml ?? null,
    license: p.license ?? null,
    changelog: p.changelog ?? null,
    homepageUrl: p.homepageUrl ?? null,
    sourceUrl: p.sourceUrl ?? null,
    documentationUrl: p.documentationUrl ?? null,
    icon: p.icon ?? null,
    metadataSources: (p.metadataSources ?? {}) as PluginRecordData['metadataSources'],
    quotaResetAt: null,
  };
}

/** The fix version's record: the flagged version's, renumbered, with provenance and its built Dockerfile. */
export function fixRecord(from: Plugin, row: PluginRemediation, candidate: Pick<EngineCandidate, 'version' | 'dockerfile'>): PluginRecordData {
  const base = recordFromRow(from);
  const ids = advisoryIds(row.cleared ?? []);
  const provenance = `Security fix of ${from.version} by Pipeline Builder remediation ${row.id}: clears ${ids.join(', ') || 'its targeted findings'}.`;
  return {
    ...base,
    version: candidate.version,
    dockerfile: candidate.dockerfile ?? base.dockerfile,
    changelog: provenance.slice(0, 10_000),
    quotaResetAt: null,
  };
}

export class RemediationPublishAbort extends Error {
  constructor(readonly code: string) { super(code); this.name = 'RemediationPublishAbort'; }
}

/**
 * Store the candidate as the fix version and move the row to `published`
 * (then `rolling_out` for a tenant rollout). Refuses (throws
 * {@link RemediationPublishAbort}) when the row stopped being active while it
 * built (cancelled by a delete, superseded) — nothing is stored then.
 */
export async function publishCandidate(input: {
  row: PluginRemediation;
  from: Plugin;
  candidate: EngineCandidate;
  uploaderId: string | null;
}): Promise<PluginRemediation> {
  const { from, candidate } = input;
  const fresh = await getRemediation(input.row.id);
  if (!fresh || !(ACTIVE_BUILD_REMEDIATION_STAGES as readonly string[]).includes(fresh.stage)) throw new RemediationPublishAbort('NO_LONGER_ACTIVE');
  const row = { ...fresh, cleared: input.row.cleared, remaining: input.row.remaining };

  const stored = await persistVersion({
    orgId: from.orgId,
    userId: SYSTEM_PLUGIN_REMEDIATION,
    // The platform acting on the org's own rows under the org's remediation setting.
    access: { isSystemAdmin: true, canPublish: true },
    pluginRecord: fixRecord(from, row, candidate),
    image: { imageDigest: candidate.ref.digest, imageSource: 'built' },
    facts: candidate.gated.facts,
    summary: candidate.gated.summary,
    skippedScan: false,
    emit: () => undefined,
  });

  // The fix version's own kept source: the patched context.
  const sha256 = createHash('sha256').update(candidate.patched.zip).digest('hex');
  const key = pluginSourceKey(from.orgId, stored.id, stored.version, sha256);
  try {
    await putRemediationArtifact(key, candidate.patched.zip);
    await recordVersionSource(stored.id, { key, sha256, sizeBytes: candidate.patched.zip.length });
  } catch { /* the version is stored source-less (overlay-only next time); plugin-sources counts it */ }

  const published = await updateRemediation(row.id, {
    stage: 'published',
    toVersion: stored.version,
    toPluginId: stored.id,
    publishedAt: new Date(),
    outcome: (row.remaining ?? []).length > 0 ? 'partial' : 'cleared',
  }, ACTIVE_BUILD_REMEDIATION_STAGES);
  if (!published) {
    // Cancelled (a delete) or superseded while the version was being stored: the cancel stands —
    // no rollout, no notice. The stored version keeps its image (it is a real version now).
    logger.warn('Remediation ended while its fix version was stored; not published', { remediationId: row.id, toPluginId: stored.id });
    return (await getRemediation(row.id)) ?? fresh;
  }
  const kept = await keepDiffWithFixVersion(published, stored, candidate.diff);
  countStage('published', published.outcome);
  countCleared(published);
  auditRemediation('plugin.remediation.published', published, {
    toVersion: stored.version,
    toPluginId: stored.id,
    imageDigest: candidate.ref.digest,
    cleared: advisoryIds(published.cleared ?? []),
    publishMode: published.publishMode,
    fixMethods: published.fixMethods,
  });
  await sendRemediationNotice({
    code: 'N36',
    orgId: published.orgId,
    remediationId: published.id,
    pluginName: published.pluginName,
    fromVersion: published.fromVersion,
    toVersion: stored.version,
    awaitingApproval: false,
    cleared: published.cleared ?? [],
    remaining: published.remaining ?? [],
    uploaderId: input.uploaderId,
  }).catch(() => undefined);

  if (isSystemOrgId(published.orgId)) {
    // Official: the maintainers' export, then the listing new-version request; the ecosystem starts the rollout.
    if (kept.patchKey) await storeOfficialExport(published.id, candidate.diff, putRemediationArtifact, from.category).catch(() => null);
    await openOfficialListingFix({ remediationId: published.id, toPluginId: stored.id, toVersion: stored.version, digest: candidate.ref.digest }).catch(() => null);
    return (await getRemediation(published.id)) ?? published;
  }
  // A failed start is counted (attempt 1) and retried by the nightly sweep, or given up at once when permanent.
  const started = await recordRolloutStart(kept, await startTenantRollout(kept), 'publish');
  return started.row ?? kept;
}

/**
 * Write the remediation's diff under the fix version's prefix and point
 * `patch_key` at it (see the module comment). Only when a diff was stored with
 * the remediation; a failed write keeps the from-version key (logged).
 */
async function keepDiffWithFixVersion(row: PluginRemediation, fix: { id: string; version: string }, diff: string): Promise<PluginRemediation> {
  if (!row.patchKey || !diff) return row;
  const key = remediationDiffKey(row.orgId, fix.id, fix.version, row.id);
  if (key === row.patchKey) return row;
  try {
    await putRemediationArtifact(key, diff);
    return (await updateRemediation(row.id, { patchKey: key })) ?? row;
  } catch (err) {
    logger.warn('Remediation diff not kept with its fix version; it goes with the from-version\'s purge', { remediationId: row.id, error: errorMessage(err) });
    return row;
  }
}
