// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The identity facts a stakeholder report needs from platform, over
 * `/internal/reporting/*` (callers: `reporting` only).
 *
 * Two questions, both of which this service structurally cannot answer:
 *
 *  - IS THIS OWNER STILL ALLOWED? A scheduled run has no caller, so it is
 *    authorized as the definition's owner. Whether that person is still an active
 *    member, still holds `reports:author` / `reports:share`, and whether the
 *    account still holds the `stakeholder_reports` add-on is all in platform.
 *    This is deliberately a CALL PER RUN rather than a cached push: an entitlement
 *    that lapsed on Tuesday must stop Wednesday's report, and a cache that is
 *    refreshed by a sync leg is exactly one missed sync away from delivering a
 *    report the customer is no longer paying for.
 *
 *  - IS THIS ADDRESS A MEMBER? A member skips email verification (the org already
 *    established they belong to it) and is admissible whatever the allowed-domain
 *    policy says. Asked one address at a time, so the org's member list never
 *    crosses the boundary.
 *
 * FAIL CLOSED. Both return `null` when platform cannot answer, and every caller
 * treats `null` as "not authorized" / "not a member". The alternative — assuming
 * authority when the authority service is unreachable — means a platform outage
 * turns into reports delivered on a lapsed subscription, or org data mailed to an
 * unverified address.
 */

import {
  createLogger,
  errorMessage,
  getServiceAuthHeader,
  InternalHttpClient,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

const logger = createLogger('report-identity');

/** What a definition's owner may still do, and what the account still holds. */
export interface ReportAuthority {
  /** False for every stop condition: no membership, deactivated, org torn down. */
  active: boolean;
  /** The `reports:*` permissions the owner currently holds. Nothing else. */
  permissions: string[];
  /** The org's resolved feature flags — `stakeholder_reports` is the one that matters. */
  features: string[];
  tier?: string;
}

/** Whether one address belongs to an active member of the org. */
export interface RecipientCheck {
  member: boolean;
  userId?: string;
  displayName?: string;
}

export interface ReportIdentity {
  authority(orgId: string, userId: string): Promise<ReportAuthority | null>;
  recipientCheck(orgId: string, email: string): Promise<RecipientCheck | null>;
}

function client(): InternalHttpClient {
  const { services } = Config.get('server');
  return new InternalHttpClient({ host: services.platformHost, port: services.platformPort });
}

const headers = () => ({
  Authorization: getServiceAuthHeader({ serviceName: 'reporting', orgId: SYSTEM_ORG_ID, role: 'member' }),
});

const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The live implementation (platform over HTTP). Exported for tests. */
export const httpReportIdentity: ReportIdentity = {
  async authority(orgId, userId) {
    try {
      const res = await client().get<{ data?: Record<string, unknown> }>(
        `/internal/reporting/report-authority/${encodeURIComponent(orgId)}/${encodeURIComponent(userId)}`,
        { headers: headers() },
      );
      const d = res.body?.data;
      if (res.statusCode >= 400 || !d || typeof d.active !== 'boolean') return null;
      return {
        active: d.active,
        permissions: strings(d.permissions),
        features: strings(d.features),
        ...(typeof d.tier === 'string' ? { tier: d.tier } : {}),
      };
    } catch (err) {
      logger.warn('Report-authority read failed', { orgId, userId, error: errorMessage(err) });
      return null;
    }
  },

  async recipientCheck(orgId, email) {
    const q = new URLSearchParams({ email });
    try {
      const res = await client().get<{ data?: Record<string, unknown> }>(
        `/internal/reporting/recipient-check/${encodeURIComponent(orgId)}?${q.toString()}`,
        { headers: headers() },
      );
      const d = res.body?.data;
      if (res.statusCode >= 400 || !d || typeof d.member !== 'boolean') return null;
      return {
        member: d.member,
        ...(typeof d.userId === 'string' ? { userId: d.userId } : {}),
        ...(typeof d.displayName === 'string' ? { displayName: d.displayName } : {}),
      };
    } catch (err) {
      // The address itself never reaches the log — it is the PII this whole
      // endpoint shape exists to keep contained.
      logger.warn('Recipient member check failed', { orgId, error: errorMessage(err) });
      return null;
    }
  },
};

let impl: ReportIdentity = httpReportIdentity;

/** The identity reads in use. */
export function reportIdentity(): ReportIdentity {
  return impl;
}

/** Swap the implementation (tests only). */
export function setReportIdentity(next: ReportIdentity): void {
  impl = next;
}
