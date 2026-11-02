// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Turning a gated image into a stored version: the ONE success tail shared by
 * the build worker and the promotion of a kept setup image, so a promoted
 * version is exactly what a passing build would have stored — the same row
 * (scan facts, `scan_summary`, default rule, the report's "latest" refresh in
 * `deployVersion`), the same `plugin.scan.skipped` record, the same post-build
 * publish request, and the same clean-up of kept setup images it supersedes.
 */

import { SYSTEM_ACTOR_ID, recordAudit, type PluginScanSummary, type WriteAccess } from '@pipeline-builder/api-core';
import type { Plugin } from '@pipeline-builder/pipeline-data';

import { supersedeKeptSetupImages } from './kept-setup-images.js';
import { pluginService } from './plugin-service.js';
import type { BuildResult } from '../helpers/docker-build.js';
import type { ImageFacts } from '../helpers/image-facts.js';
import type { GateEmit } from '../helpers/image-gates.js';
import { toPluginInsert, type PluginRecordData, type PublishCaller } from '../helpers/plugin-helpers.js';

export interface PersistVersionInput {
  orgId: string;
  userId: string;
  access: WriteAccess;
  pluginRecord: PluginRecordData;
  /** The signed image (null for an approval step, which builds none). */
  image: { imageDigest: string; imageSource: BuildResult['imageSource'] } | null;
  facts: ImageFacts | null;
  summary: PluginScanSummary | null;
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
