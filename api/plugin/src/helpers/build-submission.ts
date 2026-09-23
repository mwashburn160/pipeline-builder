// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The steps every build-queuing route shares (the zip upload and the
 * AI-generated deploy): run the fail-closed compliance preflight and queue the
 * build on the org's tier queue.
 *
 * The `plugins` quota slot itself is NOT reserved here — both routes use
 * api-server's shared `withQuotaReservation` guard, which hands ownership of the
 * slot to the queued build job via `markConsumed()`.
 */

import {
  createComplianceClient,
  errorMessage,
  type PluginComplianceAttributes,
  type QuotaService,
} from '@pipeline-builder/api-core';
import type { SSEManager } from '@pipeline-builder/api-server';

import { uploadComplianceImageFacts } from './plugin-compliance.js';
import type { PluginBuildJobData } from './plugin-helpers.js';
import { enqueueBuild, getOrgTier } from '../queue/connections.js';

type LogFn = (message: string, data?: unknown) => void;

const complianceClient = createComplianceClient();

/** What the preflight checks: the spec's attributes plus what the image facts derive from. */
export interface PreflightInput {
  attributes: PluginComplianceAttributes & { name: string };
  buildType: string;
  pluginType: string;
  keywords: string[];
  /** The compliance check's action (`upload`, `deploy-generated`). */
  action: string;
}

export type PreflightOutcome =
  | { status: 'ok'; warnings: number }
  | { status: 'blocked'; violations: unknown[] }
  | { status: 'unavailable'; error: string };

/**
 * The pre-build compliance check. The image facts (`signed`, `scanned`,
 * `vuln*`, `runAsRoot`, `packages`) don't exist until the worker has built,
 * signed and scanned the image, so for an image plugin they are DEFERRED here
 * and evaluated by the worker's post-build check; `tags` is sent now. An
 * unreachable compliance service is `unavailable` — callers fail closed.
 */
export async function compliancePreflight(orgId: string, authHeader: string, input: PreflightInput): Promise<PreflightOutcome> {
  const imageFacts = uploadComplianceImageFacts({ buildType: input.buildType, pluginType: input.pluginType, keywords: input.keywords });
  try {
    const result = await complianceClient.validatePlugin(orgId, {
      ...input.attributes,
      keywords: input.keywords,
      buildType: input.buildType,
      ...imageFacts.attributes,
    }, authHeader, undefined, input.attributes.name, input.action, imageFacts.deferredFields);
    if (result.blocked) return { status: 'blocked', violations: result.violations };
    return { status: 'ok', warnings: result.warnings.length };
  } catch (err) {
    return { status: 'unavailable', error: errorMessage(err) };
  }
}

/**
 * Queue a build on the org's per-tier queue. Binds the build-log stream's
 * owner FIRST: a client can mint a stream ticket as soon as it has the
 * requestId, so the owner must be recorded before the id is returned, or a
 * tenant could mint a ticket for another tenant's guessed stream. The bind is
 * best-effort (the worker re-binds as a backstop); a queue failure throws.
 */
export async function queuePluginBuild(input: {
  quotaService: QuotaService;
  sseManager: SSEManager;
  orgId: string;
  authHeader: string;
  jobName: string;
  jobData: PluginBuildJobData;
  logWarn: LogFn;
}): Promise<void> {
  const { quotaService, sseManager, orgId, authHeader, jobData } = input;
  await sseManager.bindStreamOwner(jobData.requestId, orgId).catch((bindErr) =>
    input.logWarn('Stream-owner bind failed (non-fatal)', { error: errorMessage(bindErr) }));
  const tier = await getOrgTier(quotaService, orgId, authHeader);
  await enqueueBuild(tier, input.jobName, jobData);
}
