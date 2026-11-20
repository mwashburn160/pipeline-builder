// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Turning a gated image into a stored version: the ONE success tail shared by
 * the build worker and the promotion of a kept setup image, so a promoted
 * version is exactly what a passing build would have stored — the same row
 * (scan facts, `scan_summary`, default rule, the report's "latest" refresh in
 * `deployVersion`), the same `plugin.scan.skipped` record, the same post-build
 * publish request, and the same clean-up of kept setup images it supersedes.
 *
 * It is also where a version's build source is KEPT: a version built from a
 * ZIP (`buildType: 'build_image'`) copies its staged ZIP into
 * `plugin-sources/<orgId>/<pluginId>/<version>/<sha256>.zip` and records the
 * pointer (services/plugin-sources.ts) BEFORE the caller's clean-up deletes the
 * staging object. A prebuilt-image upload, an approval step and a promoted
 * setup image store `source_kind = 'none'`.
 *
 * A by-name delete, restore or purge holding the name's lock
 * (helpers/plugin-name-lock.ts) refuses the store with 409 PLUGIN_NAME_LOCKED,
 * so a build that was already running when the delete began never lands a
 * version after it.
 */

import { SYSTEM_ACTOR_ID, recordAudit, type PluginScanSummary, type WriteAccess } from '@pipeline-builder/api-core';
import type { Plugin } from '@pipeline-builder/pipeline-data';

import { supersedeKeptSetupImages } from './kept-setup-images.js';
import { pluginService } from './plugin-service.js';
import { keepVersionSource } from './plugin-sources.js';
import type { BuildResult } from '../helpers/docker-build.js';
import type { ImageFacts } from '../helpers/image-facts.js';
import type { GateEmit } from '../helpers/image-gates.js';
import { toPluginInsert, type PluginRecordData, type PublishCaller } from '../helpers/plugin-helpers.js';
import { assertPluginNameUnlocked } from '../helpers/plugin-name-lock.js';

export interface PersistVersionInput {
  orgId: string;
  userId: string;
  access: WriteAccess;
  pluginRecord: PluginRecordData;
  /** The signed image (null for an approval step, which builds none). */
  image: { imageDigest: string; imageSource: BuildResult['imageSource'] } | null;
  facts: ImageFacts | null;
  summary: PluginScanSummary | null;
  /**
   * The build's staged ZIP (`BuildRequest.s3Key`), still present: kept as the
   * version's source when the version is built from it (`build_image`).
   * Absent / null = nothing to keep (`source_kind = 'none'`).
   */
  stagingKey?: string | null;
  /** Persisted UNSCANNED under PLUGIN_ALLOW_UNSCANNED. */
  skippedScan: boolean;
  /** The publish request the upload asked for (`publishRequest=true`). */
  publish?: { caller: PublishCaller };
  emit: GateEmit;
  /**
   * Runs right after the row is stored, before anything else here — the build
   * worker records its `plugin.build.completed` event there, so the audit trail
   * reads in the order things happened.
   */
  onStored?: (plugin: Plugin) => void | Promise<void>;
}

/** Store the version and run everything that follows a stored version. */
export async function persistVersion(input: PersistVersionInput): Promise<Plugin> {
  const { orgId, userId, image, facts, summary, pluginRecord } = input;
  await assertPluginNameUnlocked(orgId, pluginRecord.name);
  const result = await pluginService.deployVersion(
    toPluginInsert(pluginRecord, {
      imageDigest: image?.imageDigest ?? null,
      imageSource: image?.imageSource ?? null,
      ...(facts ? {
        vulnCritical: facts.vulnCritical,
        vulnHigh: facts.vulnHigh,
        vulnMedium: facts.vulnMedium,
        vulnLow: facts.vulnLow,
        vulnCriticalFixable: facts.vulnCriticalFixable,
        vulnHighFixable: facts.vulnHighFixable,
        scannedAt: facts.scannedAt,
        scanSummary: summary,
        runAsRoot: facts.runAsRoot,
      } : {}),
    }),
    userId,
    input.access,
  );
  // Keep the build source before anything else can drop the staging object.
  // Prebuilt images (the ZIP only carried an image tarball) keep none.
  await keepVersionSource({
    orgId,
    pluginId: result.id,
    version: result.version,
    stagingKey: pluginRecord.buildType === 'build_image' ? input.stagingKey ?? null : null,
  });
  await input.onStored?.(result);

  // The operator escape hatch persisted an UNSCANNED version: that is a
  // security-relevant exception, so it carries its own audit event.
  if (input.skippedScan && image) {
    recordAudit({
      action: 'plugin.scan.skipped',
      actorId: userId ?? SYSTEM_ACTOR_ID,
      orgId,
      targetType: 'plugin',
      targetId: result.id,
      details: { pluginName: result.name, pluginVersion: result.version, imageDigest: image.imageDigest, reason: 'PLUGIN_ALLOW_UNSCANNED' },
    });
  }

  // A kept setup image of this name+version under ANOTHER digest is superseded
  // by the version just stored: nothing can promote it any more. Best-effort.
  if (image) await supersedeKeptSetupImages(orgId, result.name, result.version, image.imageDigest);

  // Plugin ecosystem: the upload asked for a publish request — submit it now
  // that the version (and its signed digest) exists. Never fails the caller:
  // the refusal is reported to whoever is watching.
  if (input.publish) {
    const { submitAfterBuild } = await import('./ecosystem/requests.js');
    const outcome = await submitAfterBuild(input.publish.caller, result.id);
    input.emit(outcome.ok ? 'INFO' : 'WARN', `Publish request: ${outcome.message}`, {
      ...(outcome.requestId ? { publishRequestId: outcome.requestId, status: outcome.status } : {}),
    });
  }
  return result;
}
