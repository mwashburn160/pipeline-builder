// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rendering a `429 QUOTA_EXCEEDED` for a person reading a terminal or a
 * CloudFormation event — shared by the pipeline-manager CLI and the
 * plugin-lookup Lambda so both say the same thing.
 *
 * A quota refusal is NOT a rate limit: waiting a moment changes nothing, the
 * counter only empties when the period resets (or the limit is raised). So the
 * message names the quota, the numbers, the reset date and where to raise it,
 * and the callers never retry it. A 429 WITHOUT this code is an ordinary rate
 * limit (nginx, a per-org burst limiter) and keeps rate-limit wording.
 *
 * Deliberately a dependency-free leaf (the label table is a side-effect-free
 * deep import): the Lambda bundle must not pull the api-core barrel.
 */

import { QUOTA_TYPE_LABELS, QUOTA_UPGRADE_PATH, type QuotaType } from '@pipeline-builder/api-core/lib/types/common.js';

/** The error `code` api-core's `sendQuotaExceeded` answers with. */
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED';

interface QuotaExceededDetails {
  quotaType?: unknown;
  limit?: unknown;
  used?: unknown;
  resetAt?: unknown;
  upgradeUrl?: unknown;
}

/** Whether an error response body is a quota refusal (`code: 'QUOTA_EXCEEDED'`). */
export function isQuotaExceededBody(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { code?: unknown }).code === QUOTA_EXCEEDED_CODE;
}

/**
 * `"API call quota reached (25,000/25,000); resets 2026-11-05. Upgrade:
 * https://pb.example.com/dashboard/billing"` for a quota refusal body, or
 * `undefined` for anything else. `platformUrl` prefixes the RELATIVE upgrade
 * path the server sends (the dashboard and API share an origin behind nginx).
 */
export function describeQuotaExceeded(body: unknown, platformUrl: string): string | undefined {
  if (!isQuotaExceededBody(body)) return undefined;
  const details = ((body as { details?: unknown }).details ?? {}) as QuotaExceededDetails;
  const type = typeof details.quotaType === 'string' ? details.quotaType : undefined;
  const label = (type && QUOTA_TYPE_LABELS[type as QuotaType]) ?? (type ? type : 'Usage');
  const used = typeof details.used === 'number' ? details.used.toLocaleString('en-US') : '?';
  const limit = typeof details.limit === 'number' ? details.limit.toLocaleString('en-US') : '?';
  const resets = typeof details.resetAt === 'string' && details.resetAt.length >= 10
    ? `resets ${details.resetAt.slice(0, 10)}`
    : 'resets at the end of the period';
  const path = typeof details.upgradeUrl === 'string' && details.upgradeUrl.startsWith('/') ? details.upgradeUrl : QUOTA_UPGRADE_PATH;
  return `${label} quota reached (${used}/${limit}); ${resets}. Upgrade: ${platformUrl.replace(/\/+$/, '')}${path}`;
}
