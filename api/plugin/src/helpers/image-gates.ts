// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The verdict on a SCANNED, signed image before it may become a version: the
 * platform vulnerability floor (with the waivers that apply, made visible) and
 * the org's post-build compliance rules.
 *
 * One implementation for the two paths that can turn an image into a version —
 * the build worker, and the promotion of a kept setup image (which re-runs the
 * CURRENT gates on an image a past build refused) — so the two can never
 * disagree about what passes.
 */

import { AppError, ErrorCode, SYSTEM_ACTOR_ID, createLogger, recordAudit, type PluginScanSummary } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';

import { assertPostBuildCompliance, type ImageFacts } from './image-facts.js';
import type { PluginRecordData } from './plugin-helpers.js';
import { vulnGateError, waivedFor } from './scan-gates.js';
import { scanSummary, type ScanTrigger } from './vuln-scan.js';

const logger = createLogger('image-gates');

/** A message for whoever is watching (the build stream, the promote response). */
export type GateEmit = (level: 'INFO' | 'WARN', message: string, data?: Record<string, unknown>) => void;

/**
 * The platform floor over a scanned image. Builds its `scan_summary` and
 * returns the floor's refusal (`PLUGIN_VULN_GATE`) or null.
 *
 * A waiver that applies silently is just a hole in the floor, so an applied one
 * is streamed, logged, counted (`plugin_vuln_waived_total`) and AUDITED
 * (`plugin.vuln.waived`) — before the floor runs, so the record exists whether
 * the image then passes or still fails on what the waiver did not cover. Its
 * `targetId` is the image digest: no version row exists yet, and may never.
 */
export function vulnFloor(input: {
  orgId: string;
  userId: string | null;
  pluginRecord: Pick<PluginRecordData, 'name' | 'version'>;
  imageDigest: string;
  facts: ImageFacts & { scan: NonNullable<ImageFacts['scan']> };
  trigger: Exclude<ScanTrigger, 'rescan'>;
  emit: GateEmit;
}): { summary: PluginScanSummary; refusal: AppError | null } {
  const { orgId, pluginRecord, imageDigest, facts, trigger, emit } = input;
  const floorInput = { ...facts, pluginName: pluginRecord.name, orgId, pluginVersion: pluginRecord.version };
  const waived = waivedFor(floorInput);
  const summary = scanSummary(facts.scan, { imageDigest, trigger, waived, uncataloguedBinaries: facts.uncataloguedBinaries });
  if (waived.length > 0) {
    const names = [...new Set(waived.map((f) => f.packageName))];
    for (const f of waived) incCounter('plugin_vuln_waived_total', { plugin: pluginRecord.name, advisory: f.id, trigger });
    logger.warn('PLUGIN_VULN_WAIVERS exempted findings from the floor', {
      plugin: pluginRecord.name, version: pluginRecord.version, waived: waived.length, packages: names.join(', '), trigger,
    });
    emit('WARN', `${waived.length} fixable Critical finding(s) exempted by PLUGIN_VULN_WAIVERS (${names.join(', ')})`, { waived: waived.length });
    recordAudit({
      action: 'plugin.vuln.waived',
      actorId: input.userId ?? SYSTEM_ACTOR_ID,
      orgId,
      targetType: 'plugin',
      targetId: imageDigest,
      details: {
        pluginName: pluginRecord.name,
        pluginVersion: pluginRecord.version,
        imageDigest,
        waived: waived.length,
        packages: names,
        findings: waived.map((f) => f.id),
        ...(trigger === 'promote' ? { trigger } : {}),
      },
    });
  }
  return { summary, refusal: vulnGateError(floorInput) };
}

/**
 * The org's post-build compliance rules on the image's real facts. A BLOCK is a
 * verdict, returned as the refusal; an unreachable compliance service is not a
 * verdict on the image and is rethrown (the build retries it, a promotion
 * answers it as an error and keeps the image).
 */
export async function complianceRefusal(orgId: string, record: PluginRecordData, imageDigest: string, facts: ImageFacts): Promise<AppError | null> {
  try {
    await assertPostBuildCompliance(orgId, record, imageDigest, facts);
    return null;
  } catch (err) {
    if (err instanceof Error && (err as Partial<AppError>).code === ErrorCode.COMPLIANCE_VIOLATION) return err as AppError;
    throw err;
  }
}
