// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The identity facts a stakeholder report needs from platform, over
 * `/internal/reporting/*` (callers: `reporting` only).
 *
 * Three questions, none of which this service structurally can answer:
 *
 *  - IS THIS OWNER STILL ALLOWED? A scheduled run has no caller, so it is
 *    authorized as the definition's owner. Whether that person is still an active
 *    member, still holds `reports:write` / `reports:publish`, and whether the
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
 *  - WHO MAY READ THE REPORT? A published report's in-app notice goes to the
 *    members holding `reports:read`, by user id — ids only, capped by platform.
 *
 * FAIL CLOSED. All three return `null` when platform cannot answer, and every caller
 * treats `null` as "not authorized" / "not a member". The alternative — assuming
 * authority when the authority service is unreachable — means a platform outage
 * turns into reports delivered on a lapsed subscription, or org data mailed to an
 * unverified address.
 */

import {
  callInternal,
  createLogger,
  errorMessage,
  getServiceAuthHeader,
  InternalHttpClient,
  PLATFORM_INTERNAL,
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

/** The members who may read an org's reports (`reports:read`), by user id. */
export interface ReportReaders {
  userIds: string[];
  /** More members hold the permission than the answer carries (platform caps it). */
  truncated: boolean;
}

export interface ReportIdentity {
  authority(orgId: string, userId: string): Promise<ReportAuthority | null>;
  /**
   * Whether the org still holds `stakeholder_reports`, judged through ANY active
   * owner/admin — for a shared link whose owner has left. `null` when platform
   * cannot say (callers treat it as "not entitled").
   */
  orgEntitlement(orgId: string): Promise<boolean | null>;
  recipientCheck(orgId: string, email: string): Promise<RecipientCheck | null>;
  /** Who a published report's in-app notice goes to; `null` when platform cannot say. */
  readers(orgId: string): Promise<ReportReaders | null>;
}

function client(): InternalHttpClient {
  const { services } = Config.get('server');
  return new InternalHttpClient({ host: services.platformHost, port: services.platformPort });
}

const headers = () => ({
  Authorization: getServiceAuthHeader({ serviceName: 'reporting', orgId: SYSTEM_ORG_ID, role: 'member' }),
});

/** The reads, defined once in api-core (paths, params, reply normalization). */
const {
  reportAuthority: AUTHORITY, reportOrgEntitlement: ORG_ENTITLEMENT, reportRecipientCheck: RECIPIENT, reportReaders: READERS,
} = PLATFORM_INTERNAL;

/** The live implementation (platform over HTTP). Exported for tests. */
export const httpReportIdentity: ReportIdentity = {
  async authority(orgId, userId) {
    try {
      const res = await callInternal(client(), AUTHORITY, { params: { orgId, userId }, options: { headers: headers() } });
      if (!res.ok) return null;
      const d = res.data;
      return {
        active: d.active,
        permissions: d.permissions,
        features: d.features,
        ...(d.tier !== undefined ? { tier: d.tier } : {}),
      };
    } catch (err) {
      logger.warn('Report-authority read failed', { orgId, userId, error: errorMessage(err) });
      return null;
    }
  },

  async orgEntitlement(orgId) {
    try {
      // SCOPED to the org asked about, like `readers`: platform refuses any other token.
      const res = await callInternal(client(), ORG_ENTITLEMENT, {
        params: { orgId },
        options: { headers: { Authorization: getServiceAuthHeader({ serviceName: 'reporting', orgId, role: 'member' }) } },
      });
      if (!res.ok) return null;
      return res.data.entitled;
    } catch (err) {
      logger.warn('Report org-entitlement read failed', { orgId, error: errorMessage(err) });
      return null;
    }
  },

  async recipientCheck(orgId, email) {
    try {
      const res = await callInternal(client(), RECIPIENT, { params: { orgId }, query: { email }, options: { headers: headers() } });
      if (!res.ok) return null;
      const d = res.data;
      return {
        member: d.member,
        ...(d.userId !== undefined ? { userId: d.userId } : {}),
        ...(d.displayName !== undefined ? { displayName: d.displayName } : {}),
      };
    } catch (err) {
      // The address itself never reaches the log — it is the PII this whole
      // endpoint shape exists to keep contained.
      logger.warn('Recipient member check failed', { orgId, error: errorMessage(err) });
      return null;
    }
  },

  async readers(orgId) {
    try {
      // SCOPED to the org asked about, not the system org: platform refuses a token
      // minted for any other org, so one bug here cannot list another org's readers.
      const res = await callInternal(client(), READERS, {
        params: { orgId },
        options: { headers: { Authorization: getServiceAuthHeader({ serviceName: 'reporting', orgId, role: 'member' }) } },
      });
      if (!res.ok) return null;
      return { userIds: res.data.userIds, truncated: res.data.truncated };
    } catch (err) {
      logger.warn('Report-readers read failed', { orgId, error: errorMessage(err) });
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
