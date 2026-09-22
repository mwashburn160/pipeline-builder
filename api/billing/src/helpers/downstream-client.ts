// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The single billing-side client for the downstream services billing reads
 * enforcement state from and pushes entitlements to (quota, platform,
 * reporting, compliance). Every call carries the same tenant handshake —
 * `{ Authorization, 'x-org-id': orgId }` over a safe client with the billing
 * timeout — and every reader that parses `GET /quotas/:orgId`,
 * `GET /quotas/:orgId/:type` or `GET /organization/:orgId/seat-usage` funnels
 * through the typed fetchers here, so "where in the envelope does each field
 * live" is known in ONE place (divergent copies of these parsers are how
 * `body.used` vs `body.data.used` parse bugs slip in). Callers still own their
 * auth minting and their own field/validation policy on top of these.
 *
 * Reads are fail-soft: {@link getJson} returns `null` on a transport failure
 * (the safe client resolves `null`), a non-2xx, or a thrown error — a store
 * outage must never surface as an exception to the billing flows that read
 * enforcement state opportunistically. Keep-alive agents are shared per target
 * by the safe client, so a client per call is cheap.
 */

import { createLogger, createSafeClient, errorMessage } from '@pipeline-builder/api-core';
import type { QuotaTier } from '@pipeline-builder/api-core';
import { config } from '../config.js';
import { getBillingTimeout } from './billing-helpers.js';

const logger = createLogger('downstream-client');

/** A downstream service address (`config.quotaService`, `config.platformService`, …). */
export interface ServiceTarget {
  host: string;
  port: number;
}

function clientFor(service: ServiceTarget): ReturnType<typeof createSafeClient> {
  return createSafeClient({ host: service.host, port: service.port, timeout: getBillingTimeout() });
}

function tenantHeaders(orgId: string, auth: string): Record<string, string> {
  return { 'Authorization': auth, 'x-org-id': orgId };
}

/**
 * GET `path` on `service` as tenant `orgId` and return the parsed body, or
 * `null` on a transport failure / non-2xx / thrown error (logged at WARN).
 * `auth` is used as-is — the caller mints or threads it.
 */
export async function getJson<T>(service: ServiceTarget, path: string, orgId: string, auth: string): Promise<T | null> {
  try {
    const resp = await clientFor(service).get<T>(path, { headers: tenantHeaders(orgId, auth) });
    if (!resp || resp.statusCode >= 400) {
      logger.warn('Downstream read failed', { orgId, path, statusCode: resp?.statusCode });
      return null;
    }
    return resp.body ?? null;
  } catch (err) {
    logger.warn('Downstream read failed', { orgId, path, error: errorMessage(err) });
    return null;
  }
}

/**
 * PUT `body` to `path` on `service` as tenant `orgId`. Returns the response
 * status (`null` on a transport failure). Unlike {@link getJson} this does NOT
 * swallow a thrown error: the entitlement push legs record the failure reason
 * (status vs. error message) on their own audit row.
 */
export async function putJson(
  service: ServiceTarget,
  path: string,
  body: Record<string, unknown>,
  orgId: string,
  auth: string,
): Promise<{ statusCode: number } | null> {
  const resp = await clientFor(service).put(path, body, { headers: tenantHeaders(orgId, auth) });
  return resp ? { statusCode: resp.statusCode } : null;
}

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
 * both.
 */
export interface SeatUsageSnapshot {
  /** Enforced seat cap. -1 = unlimited. `null` if absent / non-numeric. */
  limit: number | null;
  /** Current pooled seat consumption. `null` if absent / non-numeric. */
  used: number | null;
}

const asNumber = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/**
 * Fetch the org's full quota snapshot (`data.quota`) from GET /quotas/:orgId.
 * Returns `null` on read failure; a 2xx with no `data.quota` also yields `null`.
 */
export async function fetchQuotaSnapshot(orgId: string, auth: string): Promise<QuotaSnapshot | null> {
  const body = await getJson<{ data?: { quota?: QuotaSnapshot } }>(
    config.quotaService, `/quotas/${encodeURIComponent(orgId)}`, orgId, auth,
  );
  return body?.data?.quota ?? null;
}

/**
 * Fetch current pooled usage for a single tracked quota type from
 * GET /quotas/:orgId/:type (`data.status.used`). Returns `null` on failure or a
 * missing/non-numeric value.
 */
export async function fetchQuotaTypeUsage(orgId: string, quotaType: string, auth: string): Promise<number | null> {
  const body = await getJson<{ data?: { status?: { used?: unknown } } }>(
    config.quotaService, `/quotas/${encodeURIComponent(orgId)}/${encodeURIComponent(quotaType)}`, orgId, auth,
  );
  return asNumber(body?.data?.status?.used);
}

/**
 * Fetch enforced seat figures from platform's GET /organization/:orgId/seat-usage.
 * Returns `null` on read failure; individual fields are `null` when absent or
 * non-numeric (`data.limit` / `data.used`).
 */
export async function fetchSeatUsage(orgId: string, auth: string): Promise<SeatUsageSnapshot | null> {
  const body = await getJson<{ data?: { limit?: unknown; used?: unknown } }>(
    config.platformService, `/organization/${encodeURIComponent(orgId)}/seat-usage`, orgId, auth,
  );
  if (!body) return null;
  return { limit: asNumber(body.data?.limit), used: asNumber(body.data?.used) };
}
