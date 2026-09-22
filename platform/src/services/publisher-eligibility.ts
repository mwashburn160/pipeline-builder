// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The platform-held facts behind a Verified-publisher application
 * (docs/plans/plugin-ecosystem.md §3.1, §3.7): which domains the publisher's
 * root org has PROVEN it owns (the DNS domain verification of the OAuth
 * onboarding work) and whether its owners have a second factor. The plugin
 * service combines these with the plan feature `verified_publisher` and
 * refuses an application (and re-checks at decision time) when any is missing.
 *
 * Read-only and minimal: domain names and counts, never a member list.
 */

import { hasSecondFactor } from './recovery-codes-service.js';
import { toOrgId } from '../helpers/org-id.js';
import { OrgDomain, UserOrganization } from '../models/index.js';

export interface PublisherEligibilityFacts {
  /** Domains the org verified by DNS and still holds verified (lowercase, sorted). */
  verifiedDomains: string[];
  /** Active owners of the org. */
  owners: number;
  /** Of those, how many have a passkey or a confirmed authenticator app. */
  ownersWithMfa: number;
}

type Id = { toString(): string };

/** Gather the Verified-eligibility facts for `orgId` (a root org). */
export async function publisherEligibilityFacts(orgId: string): Promise<PublisherEligibilityFacts> {
  const [domains, ownerRows] = await Promise.all([
    OrgDomain.find({ orgId, verified: true }).select('domain').lean() as unknown as Promise<Array<{ domain?: string }>>,
    UserOrganization.find({ organizationId: toOrgId(orgId), isActive: true, role: 'owner' }).select('userId').lean() as unknown as Promise<Array<{ userId?: Id | null }>>,
  ]);
  const ownerIds = [...new Set(ownerRows.map((r) => r.userId?.toString()).filter((u): u is string => !!u))];
  const withMfa = await Promise.all(ownerIds.map((u) => hasSecondFactor(u)));
  return {
    verifiedDomains: [...new Set(domains.map((d) => d.domain).filter((d): d is string => !!d).map((d) => d.toLowerCase()))].sort(),
    owners: ownerIds.length,
    ownersWithMfa: withMfa.filter(Boolean).length,
  };
}
