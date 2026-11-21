// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stage 3 hand-off to the pipeline service (which owns the rollout): start it
 * for a published TENANT fix (an Official fix is started by the ecosystem's
 * listing publish, orgId null — see ecosystem/remediation-fixes.ts), or cancel
 * it when the version or name is deleted.
 */

import {
  callInternal,
  ContractRequestError,
  createLogger,
  getServiceAuthHeader,
  InternalHttpClient,
  isSystemOrgId,
  PIPELINE_INTERNAL,
  SYSTEM_ORG_ID,
  type ContractHttpClient,
} from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import type { PluginRemediation } from '@pipeline-builder/pipeline-data';

import { clearedFacts } from '../ecosystem/remediation-fixes.js';

const logger = createLogger('plugin-remediation-rollout');

function livePipelineClient(): ContractHttpClient {
  const { pipelineHost, pipelinePort } = Config.get('server').services;
  return new InternalHttpClient({ host: pipelineHost, port: pipelinePort });
}

let client: () => ContractHttpClient = livePipelineClient;

/** Test hook: replace the pipeline client (nothing = the live one). */
export function setRolloutClientForTests(c?: ContractHttpClient): void {
  client = c ? () => c : livePipelineClient;
}

/**
 * The answer to one start: taken, or why not. `status` is the pipeline
 * service's HTTP status ('503'), or `unreachable` (no answer, a network error),
 * `invalid_response` (a 2xx that did not parse — the start may well have
 * landed), `request_invalid` (refused before it was sent), `not_startable`
 * (no fix version, or a system-org row). `permanent`: retrying the same start
 * cannot help — a 4xx other than 408 / 429, an invalid request, nothing to start.
 */
export type RolloutStartResult =
  | { ok: true }
  | { ok: false; status: string; permanent: boolean };

/** Whether a failed start's `status` is permanent (see {@link RolloutStartResult}). */
export function isPermanentStartStatus(status: string): boolean {
  if (/^\d{3}$/.test(status)) {
    const code = Number(status);
    return code >= 400 && code < 500 && code !== 408 && code !== 429;
  }
  return status === 'request_invalid' || status === 'not_startable';
}

const failed = (status: string): RolloutStartResult => ({ ok: false, status, permanent: isPermanentStartStatus(status) });

/**
 * Start the tenant rollout of a published fix (or, with `toVersion` overriding
 * the row's, supersede its open proposals with the owner's own version).
 * Answers whether the pipeline service took it, and why not. Never throws.
 */
export async function startTenantRollout(row: PluginRemediation, override?: { toVersion: string; toPluginId: string }): Promise<RolloutStartResult> {
  const toVersion = override?.toVersion ?? row.toVersion;
  const toPluginId = override?.toPluginId ?? row.toPluginId;
  if (!toVersion || !toPluginId || isSystemOrgId(row.orgId)) return failed('not_startable');
  try {
    const res = await callInternal(client(), PIPELINE_INTERNAL.startRemediationRollout, {
      params: { remediationId: row.id },
      body: {
        orgId: row.orgId.toLowerCase(),
        plugin: row.pluginName,
        publisher: null,
        fromVersion: row.fromVersion,
        toVersion,
        toPluginId,
        ...clearedFacts(row.targeted ?? [], row.cleared ?? []),
      },
      options: { headers: { Authorization: getServiceAuthHeader({ serviceName: 'plugin', orgId: row.orgId, role: 'member' }) }, maxRetries: 2 },
    });
    if (res.ok) return { ok: true };
    logger.warn('Remediation rollout not started', { remediationId: row.id, reason: res.reason, ...(res.reason === 'status' ? { status: res.status } : {}) });
    if (res.reason === 'status') return failed(String(res.status));
    return failed(res.reason === 'invalid-response' ? 'invalid_response' : 'unreachable');
  } catch (err) {
    logger.warn('Remediation rollout not started', { remediationId: row.id, error: (err as Error).name });
    return failed(err instanceof ContractRequestError ? 'request_invalid' : 'unreachable');
  }
}

/** Stop a remediation's rollout. Never throws; returns whether it was acknowledged. */
export async function cancelRollout(row: Pick<PluginRemediation, 'id' | 'orgId'>, reason: 'version_deleted' | 'name_deleted' | 'cancelled'): Promise<boolean> {
  try {
    const res = await callInternal(client(), PIPELINE_INTERNAL.cancelRemediationRollout, {
      params: { remediationId: row.id },
      body: { reason },
      options: { headers: { Authorization: getServiceAuthHeader({ serviceName: 'plugin', orgId: isSystemOrgId(row.orgId) ? SYSTEM_ORG_ID : row.orgId, role: 'member' }) }, maxRetries: 2 },
    });
    return res.ok;
  } catch (err) {
    logger.warn('Remediation rollout cancel failed', { remediationId: row.id, error: (err as Error).name });
    return false;
  }
}
