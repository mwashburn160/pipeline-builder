// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The single billing-side client for the quota service + platform's seat/usage
 * endpoints. Every billing reader that parses `GET /quotas/:orgId`,
 * `GET /quotas/:orgId/:type` or `GET /organization/:orgId/seat-usage` funnels
 * through here so the "where in the envelope does each field live" knowledge
 * lives in ONE place. Three copies of these parsers had drifted apart (usage
 * rollup, entitlement-drift reconciler, over-cap guard), which is what let the
 * Wave-2 `body.used` vs `body.data.used` parse bugs slip in. Callers still own
 * their auth minting and their own field/validation policy on top of these.
 *
 * All fetchers are fail-soft: they return `null` on any transport / non-2xx /
 * throw, and never raise — a store outage must never surface as an exception to
 * the billing flows that read enforcement state opportunistically.
 */

import { createLogger, createSafeClient, errorMessage } from '@pipeline-builder/api-core';
import type { QuotaTier } from '@pipeline-builder/api-core';
import { config } from '../config.js';
import { getBillingTimeout } from './billing-helpers.js';

const logger = createLogger('quota-client');

/**
 * Per-type summary as returned by GET /quotas/:orgId (quota service's
 * `QuotaSummary`). Limit, usage and reset all live INSIDE this object — there
 * is NO sibling usage map. `remaining`/`unlimited` are present but unused here.
 */
export interface QuotaSummary {
  limit: number;
  used: number;
  remaining?: number;
  unlimited?: boolean;
  resetAt: string;
}

/** Shape of `data.quota` returned by GET /quotas/:orgId. */
export interface QuotaSnapshot {
  tier: QuotaTier;
  /** Keyed by quota type; each value is a full QuotaSummary object. */
  quotas: Record<string, QuotaSummary>;
  name?: string;
  slug?: string;
}

/**
 * Enforced seat figures from GET /organization/:orgId/seat-usage (`data.limit`
 * / `data.used`). Each field is `null` when the payload omitted it or it wasn't
 * numeric, so a caller that only needs one of the two isn't forced to require
 * both — matching the three original readers (one wanted `used`, one wanted
 * `limit`, one wanted both).
 */
export interface SeatUsageSnapshot {
  /** Enforced seat cap. -1 = unlimited. `null` if absent / non-numeric. */
  limit: number | null;
  /** Current pooled seat consumption. `null` if absent / non-numeric. */
  used: number | null;
}

function quotaClient() {
  return createSafeClient({
    host: config.quotaService.host,
    port: config.quotaService.port,
    timeout: getBillingTimeout(),
  });
}

function platformClient() {
  return createSafeClient({
    host: config.platformService.host,
    port: config.platformService.port,
    timeout: getBillingTimeout(),
  });
}

function tenantHeaders(orgId: string, auth: string): Record<string, string> {
  return { 'Authorization': auth, 'x-org-id': orgId };
}

const asNumber = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/**
 * Fetch the org's full quota snapshot (`data.quota`) from GET /quotas/:orgId.
 * Returns `null` on transport / non-2xx / throw. `auth` is used as-is (the
 * caller mints/threads it); a 2xx with no `data.quota` also yields `null`.
 */
export async function fetchQuotaSnapshot(orgId: string, auth: string): Promise<QuotaSnapshot | null> {
  try {
    const resp = await quotaClient().get<{ success?: boolean; data?: { quota?: QuotaSnapshot } }>(
      `/quotas/${encodeURIComponent(orgId)}`,
      { headers: tenantHeaders(orgId, auth) },
    );
    if (!resp || resp.statusCode >= 400) {
      logger.warn('Quota snapshot fetch failed', { orgId, statusCode: resp?.statusCode });
      return null;
    }
    return resp.body?.data?.quota ?? null;
  } catch (err) {
    logger.warn('Quota snapshot fetch threw', { orgId, error: errorMessage(err) });
    return null;
  }
}

/**
 * Fetch current pooled usage for a single tracked quota type from
 * GET /quotas/:orgId/:type (`data.status.used`). Returns `null` on failure or a
 * missing/non-numeric value.
 */
export async function fetchQuotaTypeUsage(orgId: string, quotaType: string, auth: string): Promise<number | null> {
  try {
    const resp = await quotaClient().get<{ data?: { status?: { used?: number } } }>(
      `/quotas/${encodeURIComponent(orgId)}/${encodeURIComponent(quotaType)}`,
      { headers: tenantHeaders(orgId, auth) },
    );
    if (resp && resp.statusCode < 400) return resp.body?.data?.status?.used ?? null;
  } catch (err) {
    logger.warn('Quota type usage fetch threw', { orgId, quotaType, error: errorMessage(err) });
  }
  return null;
}

/**
 * Fetch enforced seat figures from platform's GET /organization/:orgId/seat-usage.
 * Returns `null` on transport / non-2xx / throw; individual fields are `null`
 * when absent or non-numeric (`data.limit` / `data.used`).
 */
export async function fetchSeatUsage(orgId: string, auth: string): Promise<SeatUsageSnapshot | null> {
  try {
    const resp = await platformClient().get<{ success?: boolean; data?: { limit?: number; used?: number } }>(
      `/organization/${encodeURIComponent(orgId)}/seat-usage`,
      { headers: tenantHeaders(orgId, auth) },
    );
    if (!resp || resp.statusCode >= 400) {
      logger.warn('Seat usage fetch failed', { orgId, statusCode: resp?.statusCode });
      return null;
    }
    const data = resp.body?.data;
    return { limit: asNumber(data?.limit), used: asNumber(data?.used) };
  } catch (err) {
    logger.warn('Seat usage fetch threw', { orgId, error: errorMessage(err) });
    return null;
  }
}
