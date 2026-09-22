// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Automatic Verified-publisher eligibility (docs/plans/plugin-ecosystem.md
 * §3.1, §3.7). An org may apply for the Verified badge only when ALL hold:
 *
 *  - `plan`: its plan includes `verified_publisher` (Team, Enterprise, or the
 *    self-hosted `unlimited` tier);
 *  - `domain`: its root org has a DNS-VERIFIED domain (platform's domain
 *    verification); a domain named in the application must be one of them;
 *  - `owner_mfa`: every active owner has a second factor (passkey or
 *    authenticator app).
 *
 * Checked at APPLICATION time and again at DECISION time (a plan downgrade, a
 * lapsed domain or a removed factor between the two refuses the approval).
 * The platform-held facts FAIL CLOSED: when platform can't answer, the check
 * is "unknown" and the application or approval is refused as unavailable.
 * The badge itself is still awarded by two-person system-org review.
 */

import {
  emitCounter,
  ErrorCode,
  getQuotaServiceAuthHeader,
  TIER_FEATURES,
} from '@pipeline-builder/api-core';

import { ecosystemDeps, EcosystemError } from './context.js';
import { platformReads } from './platform-reads.js';

export type VerifiedCheckId = 'plan' | 'domain' | 'owner_mfa';

export interface VerifiedCheck {
  id: VerifiedCheckId;
  /** `null` when it could not be checked (platform unreachable). */
  ok: boolean | null;
  detail: string;
}

export interface VerifiedEligibility {
  eligible: boolean;
  checkedAt: string;
  checks: VerifiedCheck[];
  /** The org's DNS-verified domains (empty when unknown). */
  verifiedDomains: string[];
}

/** Whether the org's plan includes `verified_publisher` (null = the quota service didn't answer). */
async function planIncludesVerified(orgId: string): Promise<boolean | null> {
  try {
    const tier = await ecosystemDeps().quotaService.getTier(orgId, getQuotaServiceAuthHeader(orgId));
    return (TIER_FEATURES[tier] ?? []).includes('verified_publisher');
  } catch {
    return null;
  }
}

/**
 * Run the three checks for `orgId` (a root org). `planEligible` is the
 * application-time answer from the caller's token (its features); omitted, the
 * org's CURRENT plan is looked up (decision time). `domain` is the domain the
 * application named, if any.
 */
export async function checkVerifiedEligibility(
  orgId: string,
  opts: { planEligible?: boolean; domain?: string | null } = {},
): Promise<VerifiedEligibility> {
  const [plan, facts] = await Promise.all([
    opts.planEligible !== undefined ? Promise.resolve(opts.planEligible) : planIncludesVerified(orgId),
    platformReads().eligibility(orgId),
  ]);
  const domains = facts?.verifiedDomains ?? [];
  const named = opts.domain ? opts.domain.trim().toLowerCase() : null;

  const checks: VerifiedCheck[] = [
    {
      id: 'plan',
      ok: plan,
      detail: plan === null ? 'The plan could not be checked.'
        : plan ? 'The plan includes Verified publishing.'
          : 'Verified publishing needs the Team or Enterprise plan.',
    },
    {
      id: 'domain',
      ok: facts === null ? null : named ? domains.includes(named) : domains.length > 0,
      detail: facts === null ? 'Verified domains could not be checked.'
        : named && !domains.includes(named) ? `${named} is not a verified domain of the organization${domains.length ? ` (verified: ${domains.join(', ')})` : ''}.`
          : domains.length > 0 ? `Verified domain${domains.length === 1 ? '' : 's'}: ${domains.join(', ')}.`
            : 'The organization has no DNS-verified domain. Verify one under Settings → Email domains.',
    },
    {
      id: 'owner_mfa',
      ok: facts === null ? null : facts.owners > 0 && facts.ownersWithMfa === facts.owners,
      detail: facts === null ? 'Owner two-factor enrolment could not be checked.'
        : facts.owners === 0 ? 'The organization has no active owner.'
          : facts.ownersWithMfa === facts.owners ? 'Every owner has two-factor authentication.'
            : `${facts.owners - facts.ownersWithMfa} of ${facts.owners} owner${facts.owners === 1 ? ' has' : 's have'} no passkey or authenticator app.`,
    },
  ];
  return {
    eligible: checks.every((c) => c.ok === true),
    checkedAt: new Date().toISOString(),
    checks,
    verifiedDomains: domains,
  };
}

const REFUSAL: Record<VerifiedCheckId, ErrorCode> = {
  plan: ErrorCode.VERIFIED_PLAN_REQUIRED,
  domain: ErrorCode.VERIFIED_DOMAIN_REQUIRED,
  owner_mfa: ErrorCode.VERIFIED_OWNER_MFA_REQUIRED,
};

/**
 * Refuse when any check failed (the first failure's code; `details.checks`
 * lists all three) or couldn't be made (503 — fail closed, retry later).
 */
export function assertVerifiedEligible(e: VerifiedEligibility, stage: 'application' | 'decision'): void {
  if (e.eligible) return;
  const failed = e.checks.find((c) => c.ok === false);
  const check = failed ?? e.checks.find((c) => c.ok === null)!;
  emitCounter('ecosystem_verified_eligibility_refused_total', { check: check.id, stage, outcome: failed ? 'failed' : 'unknown' });
  const details = { checks: e.checks };
  if (failed) throw new EcosystemError(REFUSAL[failed.id], failed.detail, details);
  throw new EcosystemError(ErrorCode.SERVICE_UNAVAILABLE, `Verified eligibility could not be checked: ${check.detail} Try again shortly.`, details);
}
