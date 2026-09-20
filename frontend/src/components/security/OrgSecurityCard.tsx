// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { useFetch } from '@/hooks/useFetch';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import api from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { OrgMfaPolicy } from '@/types';
import { ORG_MFA_SETTINGS_HREF, ORG_SSO_SETTINGS_HREF } from './SecurityPostureStrip';

interface OrgSecurityCardProps {
  orgId: string;
  /** The viewer holds `org:idp` — the only permission that can read the IdP config. */
  canReadIdp: boolean;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md bg-surface-muted px-3 py-2">
      <div className="text-xs text-fg-muted">{label}</div>
      <div className="mt-1 text-sm font-medium text-fg">{children}</div>
    </div>
  );
}

function mfaRequirement(policy: OrgMfaPolicy) {
  if (!policy.requireMfa) return <Badge color="gray">Not required</Badge>;
  if (policy.enforced) return <Badge color="green">Required</Badge>;
  return <Badge color="yellow">Required from {formatDate(policy.graceUntil)}</Badge>;
}

/**
 * "Organization security" for an admin's home page: is two-factor required,
 * how many members could not meet it today, is SSO configured, and whether the
 * org has declared its IdP enforces MFA.
 *
 * Same sources as the settings that change them (`GET …/mfa-policy`, whose
 * `enrolment` counts MfaPolicySettings shows; `GET …/idp`). Wording stays at
 * what those report: enrolment means "holds a passkey or authenticator app",
 * and "IdP enforces MFA" is the org's own declaration, not something checked.
 */
export function OrgSecurityCard({ orgId, canReadIdp }: OrgSecurityCardProps) {
  const ssoGate = useFeatureGate('sso');
  const readIdp = canReadIdp && ssoGate.isLoaded && ssoGate.entitled;

  const mfa = useFetch(
    async (signal) => (await api.getMfaPolicy(orgId, { signal })).data ?? null,
    [orgId],
  );
  const idp = useFetch(
    async (signal) => (readIdp ? { config: (await api.getOwnOrgIdpConfig(orgId, { signal })).data?.config ?? null } : null),
    [readIdp, orgId],
  );

  const policy = mfa.data;
  const without = policy?.enrolment ? policy.enrolment.members - policy.enrolment.enrolled : null;

  return (
    <Card className="mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-fg inline-flex items-center gap-1.5">
          <ShieldCheck className="w-4 h-4 text-fg-muted" aria-hidden />
          Organization security
        </h3>
        <Link href={ORG_MFA_SETTINGS_HREF} className="action-link text-xs">Security settings →</Link>
      </div>

      {mfa.error ? (
        <RetryError message={mfa.error.message || 'Failed to load the two-factor policy'} onRetry={mfa.refetch} />
      ) : mfa.loading && !policy ? (
        <LoadingSpinner size="sm" />
      ) : policy ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Row label="Two-factor">
            {mfaRequirement(policy)}
            {policy.inheritedFrom && (
              <div className="mt-1 text-xs font-normal text-fg-muted">
                Set by {policy.inheritedFromName ?? 'the parent organization'}
              </div>
            )}
          </Row>
          <Row label="Members without a passkey or authenticator app">
            {without === null || !policy.enrolment ? (
              <span className="text-fg-muted">—</span>
            ) : (
              <span className={without > 0 && policy.requireMfa ? 'text-amber-600 dark:text-amber-400' : undefined}>
                {without} of {policy.enrolment.members}
              </span>
            )}
          </Row>
          <Row label="Single sign-on">
            {!readIdp ? (
              <span className="text-fg-muted">{ssoGate.isLoaded && !ssoGate.entitled ? 'Not on your plan' : '—'}</span>
            ) : idp.error ? (
              <span className="text-fg-muted">Unavailable</span>
            ) : !idp.data ? (
              <LoadingSpinner size="sm" />
            ) : idp.data.config ? (
              <Link href={ORG_SSO_SETTINGS_HREF} className="action-link">
                {idp.data.config.enabled ? 'Configured' : 'Configured, disabled'} ({idp.data.config.protocol.toUpperCase()})
              </Link>
            ) : (
              <Link href={ORG_SSO_SETTINGS_HREF} className="action-link">Not configured</Link>
            )}
          </Row>
          <Row label="IdP enforces MFA (declared)">
            {policy.idpEnforcesMfa ? 'Yes' : 'No'}
          </Row>
        </div>
      ) : null}
    </Card>
  );
}
