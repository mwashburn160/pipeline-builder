// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Quota wiring for ops-center: the `apiCalls` meter + check on the tenant
 * surfaces, and the F-feature-table quotas (dashboards, alertRules,
 * alertDestinations) the dashboards / alerting writes reserve.
 *
 * Feature quotas reserve against the ACCOUNT ROOT, never the caller org (teams
 * carry `-1` local feature limits so only the root's pooled cap binds — see
 * platform's org service). Platform resolved the root from its own Mongo org
 * hierarchy; ops-center asks platform through the typed internal contract
 * `PLATFORM_INTERNAL.orgAccountRoot` (services/platform-client.ts).
 */

import { createLogger, createQuotaService, decrementQuota, errorMessage, getServiceAuthHeader, reserveQuota, sendQuotaReserveDenied } from '@pipeline-builder/api-core';
import type { QuotaReserveResult, QuotaType } from '@pipeline-builder/api-core';
import { apiCallsQuota } from '@pipeline-builder/api-server';
import type { RequestHandler, Response } from 'express';
import { PlatformUnavailableError, resolveAccountRoot } from '../services/platform-client.js';

export type { QuotaType };

const SERVICE = 'ops-center';
const logger = createLogger('feature-quota');

/** Quota service client (QUOTA_SERVICE_HOST / _PORT from the environment, like every sibling). */
export const quotaService = createQuotaService();

/**
 * Reserve one slot of a feature quota against the org's account root. A root
 * platform cannot resolve is an UNCONFIRMED reservation (fail closed, answered
 * 503 by `sendQuotaReserveDenied`) — never a guessed root, and never a raw 500.
 */
export async function reserveFeatureQuota(orgId: string, quotaType: QuotaType): Promise<QuotaReserveResult> {
  let rootOrgId: string;
  try {
    rootOrgId = await resolveAccountRoot(orgId);
  } catch (err) {
    if (!(err instanceof PlatformUnavailableError)) throw err;
    logger.warn('Feature-quota reserve refused: account root unresolved', { orgId, quotaType, error: errorMessage(err) });
    return { exceeded: true, unavailable: true, quota: { type: quotaType, limit: 0, used: 0, remaining: 0 } };
  }
  const auth = getServiceAuthHeader({ serviceName: SERVICE, orgId: rootOrgId, role: 'member' });
  return reserveQuota(quotaService, rootOrgId, quotaType, auth);
}

/**
 * Give back a feature-quota slot (fire-and-forget) against the same root the
 * reservation used. `reservation` is the slot being rolled back, or `null` for
 * a release with none in hand (the delete path). A FAIL-OPEN reservation
 * reserved nothing, so rolling it back is a no-op.
 */
export function releaseFeatureQuota(
  orgId: string,
  quotaType: QuotaType,
  logWarn: (msg: string, data?: unknown) => void,
  reservation: QuotaReserveResult | null,
): void {
  if (reservation?.failOpen === true) return;
  const resetAtSnapshot = reservation?.quota.resetAt;
  void resolveAccountRoot(orgId)
    .then((rootOrgId) => {
      const auth = getServiceAuthHeader({ serviceName: SERVICE, orgId: rootOrgId, role: 'member' });
      decrementQuota(quotaService, rootOrgId, quotaType, auth, logWarn, 1, resetAtSnapshot);
    })
    .catch((err: unknown) => logWarn('Feature-quota release skipped (root resolution failed)', { error: errorMessage(err) }));
}

/**
 * Run a write that adds one live row of a feature-quota type under a
 * reservation: an exceeded/unavailable quota answers the request (429/503) and
 * `write` never runs; the slot is given back if `write` throws or returns
 * `false` (it wrote nothing).
 */
export async function withFeatureQuota(
  res: Response,
  orgId: string,
  quotaType: QuotaType,
  write: () => Promise<boolean | void>,
): Promise<void> {
  const reservation = await reserveFeatureQuota(orgId, quotaType);
  if (reservation.exceeded) {
    sendQuotaReserveDenied(res, quotaType, reservation);
    return;
  }
  const release = () => releaseFeatureQuota(orgId, quotaType, logger.warn.bind(logger), reservation);
  let kept: boolean | void;
  try {
    kept = await write();
  } catch (err) {
    release();
    throw err;
  }
  if (kept === false) release();
}

/** Meter `apiCalls` once per 2xx and gate on it once the caller is verified (run by `requireAuth`). */
export const opsApiCallsQuota: RequestHandler[] = apiCallsQuota(quotaService);
