// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * First-event self-registration, reporting's side: ask the pipeline service —
 * the registry's owner — to register deployed pipelines whose events arrived
 * with no registry row (PIPELINE_INTERNAL.registerFromFirstEvent). Reporting
 * never writes the registry itself.
 *
 * FAIL-SAFE. Any failure (unreachable, non-2xx, timeout, malformed reply)
 * answers "nothing registered", so the caller keeps today's behaviour: the
 * events are skipped and counted as `unregistered_pipeline`.
 */

import {
  callInternal,
  createLogger,
  errorMessage,
  getServiceAuthHeader,
  InternalHttpClient,
  MAX_FIRST_EVENT_ORGS,
  MAX_FIRST_EVENT_PIPELINES,
  PIPELINE_INTERNAL,
  serviceEndpoint,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { REPORTING_HTTP_TIMEOUT_MS } from '../helpers/report-helpers.js';

const logger = createLogger('first-event-registration');

/** A pipeline offered for registration, with the region its event came from. */
export interface FirstEventCandidate {
  pipelineId: string;
  region?: string;
}

let client: InternalHttpClient | undefined;
function pipelineClient(): InternalHttpClient {
  if (!client) {
    const { host, port } = serviceEndpoint('pipeline');
    client = new InternalHttpClient({ host, port });
  }
  return client;
}

/**
 * Pipelines and allowed orgs per call: the contract's own caps. An ingest
 * batch (`MAX_EVENTS_PER_BATCH`) is tunable past the pipeline cap, and an
 * over-long list is a 400 that registers none of them, so larger sets go in
 * several calls.
 */
const MAX_PIPELINES_PER_CALL = MAX_FIRST_EVENT_PIPELINES;
const MAX_ORGS_PER_CALL = MAX_FIRST_EVENT_ORGS;

/**
 * The candidates the pipeline service registered (or found already registered
 * in their own org). `allowedOrgIds` is the ingest caller's allow-list — the
 * pipeline service registers a pipeline only inside it. Never throws; a failed
 * call answers "none registered" for its own candidates only.
 */
export async function registerFirstEventPipelines(candidates: FirstEventCandidate[], allowedOrgIds: readonly string[]): Promise<string[]> {
  if (candidates.length === 0 || allowedOrgIds.length === 0) return [];
  // The candidates' orgs are unknown here (they have no registry row yet), so a
  // roll-up past the contract's org cap is offered as several allow-lists; a
  // pipeline registered under one is not offered again under the next.
  const registered = new Set<string>();
  for (let o = 0; o < allowedOrgIds.length; o += MAX_ORGS_PER_CALL) {
    const orgs = allowedOrgIds.slice(o, o + MAX_ORGS_PER_CALL);
    const pending = candidates.filter((c) => !registered.has(c.pipelineId));
    for (let i = 0; i < pending.length; i += MAX_PIPELINES_PER_CALL) {
      for (const id of await registerChunk(pending.slice(i, i + MAX_PIPELINES_PER_CALL), orgs)) registered.add(id);
    }
    if (registered.size === candidates.length) break;
  }
  return [...registered];
}

async function registerChunk(candidates: FirstEventCandidate[], allowedOrgIds: readonly string[]): Promise<string[]> {
  try {
    const res = await callInternal(pipelineClient(), PIPELINE_INTERNAL.registerFromFirstEvent, {
      body: { allowedOrgIds: [...allowedOrgIds], pipelines: candidates },
      // System-org token: the pipelines may belong to any org in the caller's
      // roll-up, and the endpoint confines itself to `allowedOrgIds`.
      options: {
        headers: { Authorization: getServiceAuthHeader({ serviceName: 'reporting', orgId: SYSTEM_ORG_ID, role: 'member' }) },
        timeout: REPORTING_HTTP_TIMEOUT_MS,
      },
    });
    if (!res.ok) {
      logger.warn('First-event registration refused; the events stay skipped', { reason: res.reason, count: candidates.length });
      return [];
    }
    return res.data.registered;
  } catch (err) {
    logger.warn('First-event registration unavailable; the events stay skipped', { count: candidates.length, error: errorMessage(err) });
    return [];
  }
}
