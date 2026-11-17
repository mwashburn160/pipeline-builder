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
  callInternal,
  createLogger,
  errorMessage,
  getServiceAuthHeader,
  InternalHttpClient,
  PLATFORM_INTERNAL,
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

/** The two reads, defined once in api-core (paths, query, reply shapes). */
const { publisherEligibility: ELIGIBILITY, ecosystemApprovers: APPROVERS } = PLATFORM_INTERNAL;

function client(): InternalHttpClient {
  const { services } = Config.get('server');
  return new InternalHttpClient({ host: services.platformHost, port: services.platformPort });
}

const headers = () => ({ Authorization: getServiceAuthHeader({ serviceName: 'plugin', orgId: SYSTEM_ORG_ID, role: 'member' }) });

/** The live implementation (platform over HTTP). Exported for tests. */
export const httpPlatformReads: PlatformReads = {
  async eligibility(orgId) {
    try {
      // The contract requires non-negative finite counts and a domain list (non-strings dropped).
      const res = await callInternal(client(), ELIGIBILITY, { params: { orgId }, options: { headers: headers() } });
      if (!res.ok) return null;
      const { verifiedDomains, owners, ownersWithMfa } = res.data;
      return { verifiedDomains, owners, ownersWithMfa };
    } catch (err) {
      logger.warn('Verified-eligibility read failed', { orgId, error: errorMessage(err) });
      return null;
    }
  },

  async approvers(permission, exclude = {}) {
    const query = {
      permission,
      excludeOrgIds: exclude.orgIds?.length ? [...new Set(exclude.orgIds)].join(',') : undefined,
      excludeUserIds: exclude.userIds?.length ? [...new Set(exclude.userIds)].join(',') : undefined,
    };
    try {
      const res = await callInternal(client(), APPROVERS, { query, options: { headers: headers() } });
      if (!res.ok) return null;
      const { holders, eligible, superadmins } = res.data;
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
