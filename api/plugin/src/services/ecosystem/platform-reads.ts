// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The platform reads ecosystem governance needs (docs/plugin-publishing.md
 * ), over platform's `/internal/ecosystem/*` routes (callers:
 * `plugin` only):
 *
 *  - the Verified application's platform-held facts: the org's DNS-verified
 *    domains and whether its owners have a second factor;
 *  - how many Ecosystem Managers could decide a request (holders of the
 *    decision permission in the system org, minus conflicts of interest).
 *
 * Both return `null` when platform can't answer, so each caller picks its own
 * fail policy: an eligibility check FAILS CLOSED (the application waits), an
 * approver count shows "unknown" rather than a false shortage.
 */

import {
  createLogger,
  errorMessage,
  getServiceAuthHeader,
  InternalHttpClient,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

import type { DecisionPermission } from './policy.js';

const logger = createLogger('ecosystem-platform-reads');

/** The Verified application's platform-held facts about an org. */
export interface EligibilityFacts {
  verifiedDomains: string[];
  owners: number;
  ownersWithMfa: number;
}

/** How many people could decide (counts only). */
export interface ApproverCount {
  holders: number;
  eligible: number;
  superadmins: number;
}

export interface ApproverExclusions {
  /** Members of these orgs have a conflict of interest. */
  orgIds?: readonly string[];
  /** These users are excluded (the submitter, the first approver). */
  userIds?: readonly string[];
}

export interface PlatformReads {
  eligibility(orgId: string): Promise<EligibilityFacts | null>;
  approvers(permission: DecisionPermission, exclude?: ApproverExclusions): Promise<ApproverCount | null>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function client(): InternalHttpClient {
  const { services } = Config.get('server');
  return new InternalHttpClient({ host: services.platformHost, port: services.platformPort, timeout: 5_000 });
}

const headers = () => ({ Authorization: getServiceAuthHeader({ serviceName: 'plugin', orgId: SYSTEM_ORG_ID, role: 'member' }) });

/** The live implementation (platform over HTTP). Exported for tests. */
export const httpPlatformReads: PlatformReads = {
  async eligibility(orgId) {
    try {
      const res = await client().get<{ data?: Record<string, unknown> }>(
        `/internal/ecosystem/publisher-eligibility/${encodeURIComponent(orgId)}`, { headers: headers() });
      const d = res.body?.data;
      if (res.statusCode >= 400 || !d) return null;
      const owners = num(d.owners);
      const ownersWithMfa = num(d.ownersWithMfa);
      if (!Array.isArray(d.verifiedDomains) || owners === null || ownersWithMfa === null) return null;
      return { verifiedDomains: d.verifiedDomains.filter((x): x is string => typeof x === 'string'), owners, ownersWithMfa };
    } catch (err) {
      logger.warn('Verified-eligibility read failed', { orgId, error: errorMessage(err) });
      return null;
    }
  },

  async approvers(permission, exclude = {}) {
    const q = new URLSearchParams({ permission });
    if (exclude.orgIds?.length) q.set('excludeOrgIds', [...new Set(exclude.orgIds)].join(','));
    if (exclude.userIds?.length) q.set('excludeUserIds', [...new Set(exclude.userIds)].join(','));
    try {
      const res = await client().get<{ data?: Record<string, unknown> }>(`/internal/ecosystem/approvers?${q.toString()}`, { headers: headers() });
      const d = res.body?.data;
      if (res.statusCode >= 400 || !d) return null;
      const holders = num(d.holders);
      const eligible = num(d.eligible);
      const superadmins = num(d.superadmins);
      if (holders === null || eligible === null || superadmins === null) return null;
      return { holders, eligible, superadmins };
    } catch (err) {
      logger.warn('Approver-count read failed', { permission, error: errorMessage(err) });
      return null;
    }
  },
};

let reads: PlatformReads = httpPlatformReads;

/** The platform reads in use. */
export function platformReads(): PlatformReads {
  return reads;
}

/** Test hook: replace the platform reads (pass nothing to restore the live ones). */
export function setPlatformReadsForTests(r?: PlatformReads): void {
  reads = r ?? httpPlatformReads;
}
