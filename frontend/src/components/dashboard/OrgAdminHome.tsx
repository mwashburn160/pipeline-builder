// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Health-focused home view for organization admins / owners.
 *
 * Designed around the question "is my org healthy?" rather than "what's
 * available to me?" — so the top of the page is dominated by quota /
 * compliance / billing signals, not a service catalog. The catalog
 * still lives below for navigation, but the surfaced data points
 * answer "anything I need to act on?" at a glance.
 *
 * Cards:
 *   1. Quota health — % used per type with breach-warning badges
 *   2. Pending invitations + member count (+ team count when the org parents teams)
 *   3. Compliance pulse — last 3 blocked entries (if any)
 *   4. Billing snapshot — current plan + period days elapsed
 *   5. Organization security — MFA requirement, members without a second
 *      factor, SSO, IdP-enforced MFA (holders of `org:settings` only)
 */

import { useMemo } from 'react';
import Link from 'next/link';
import {
  BarChart3, Mail, Shield, CreditCard, AlertTriangle, Activity, ArrowRight, Building2,
} from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useFeatures } from '@/hooks/useFeatures';
import { useOrgHierarchy } from '@/hooks/useOrgHierarchy';
import { useAuth } from '@/hooks/useAuth';
import { useFetch } from '@/hooks/useFetch';
import { OrgSecurityCard } from '@/components/security/OrgSecurityCard';
import { hasPermission } from '@/lib/auth-helpers';
import api from '@/lib/api';
import { queries } from '@/lib/api-cache';
import { runQuery } from '@/lib/query-cache';
import { fmtNum } from '@/lib/format';
import { complianceActionLabel } from '@/lib/compliance-styles';
import { POOLING_TITLE } from '@/components/quotas/constants';
import type { OrgQuotaResponse, DisplayedQuotaType, Subscription } from '@/types';
import type { ComplianceAuditEntry } from '@/types/compliance';

/** Stable empty list, so `blockedEntries` doesn't re-memo on every render. */
const EMPTY_COMPLIANCE: ComplianceAuditEntry[] = [];

// The home quota-health row shows the curated 4-tile subset (grid-cols-4).
const QUOTA_LABELS: Record<DisplayedQuotaType, string> = {
  plugins: 'Plugins',
  pipelines: 'Pipelines',
  apiCalls: 'API calls',
  aiCalls: 'AI calls',
};

function quotaTone(used: number, limit: number, unlimited: boolean): 'green' | 'yellow' | 'red' {
  if (unlimited || limit <= 0) return 'green';
  const pct = (used / limit) * 100;
  if (pct >= 90) return 'red';
  if (pct >= 75) return 'yellow';
  return 'green';
}

interface Props {
  /** Current user's active org id — needed for the team-members lookup. */
  organizationId?: string;
}

export function OrgAdminHome({ organizationId }: Props) {
  const { isEnabled } = useFeatures();
  const billingEnabled = isEnabled('billing');
  // Hierarchy tiles render only where they mean something: a team count when
  // the org parents teams, a "pooled" note when it IS a team, and the
  // inherited-authority note only when the session has no membership here.
  const { isChildOrg, hasChildOrgs, childOrgCount, parentOrgName, viaAncestor } = useOrgHierarchy();
  const { user } = useAuth();
  const canSeeOrgSecurity = !!organizationId && hasPermission(user, 'org:settings');
  // Every call here is independent and best-effort — a missing answer degrades
  // to an empty section rather than blocking the page — so they settle together
  // into ONE result instead of five separate pieces of loading state.
  //
  // `memberCount` is skipped without an org id (a cross-org sysadmin session
  // hits this path without one), and the subscription is skipped when billing
  // is disabled, so a deliberately-disabled service isn't asked for 503s.
  // Only the member COUNT is needed, so it asks for a 1-row page and reads the
  // total off the pagination block.
  const home = useFetch(async (signal) => {
    const memberPromise = organizationId
      ? runQuery(queries.orgMembers(organizationId, { limit: 1 }), { signal }).catch(() => null)
      : Promise.resolve(null);
    const subscriptionPromise = billingEnabled
      ? runQuery(queries.subscription(), { signal }).catch(() => null)
      : Promise.resolve(null);

    const [quotaRes, inviteRes, complianceRes, subRes, memberRes] = await Promise.allSettled([
      api.getOwnQuotas({ signal }),
      api.listInvitations({ status: 'pending', limit: 1 }, { signal }),
      api.getComplianceAuditLog({ limit: 5 }, { signal }),
      subscriptionPromise,
      memberPromise,
    ]);

    return {
      // api.getOwnQuotas returns `{ quota: OrgQuotaResponse }`; use that
      // canonical shape directly rather than a `q.quota ?? q` fallback that
      // masks envelope-vs-bare shape drift.
      quotas: quotaRes.status === 'fulfilled' && quotaRes.value.success && quotaRes.value.data
        ? quotaRes.value.data.quota : null,
      pendingInvites: inviteRes.status === 'fulfilled' && inviteRes.value.success && inviteRes.value.data
        ? inviteRes.value.data.pagination?.total ?? inviteRes.value.data.invitations.length : 0,
      compliance: complianceRes.status === 'fulfilled' && complianceRes.value.success && complianceRes.value.data
        ? complianceRes.value.data.entries : ([] as ComplianceAuditEntry[]),
      subscription: subRes.status === 'fulfilled' && subRes.value && subRes.value.success && subRes.value.data
        ? subRes.value.data.subscription : null,
      memberCount: memberRes.status === 'fulfilled' && memberRes.value && memberRes.value.success && memberRes.value.data
        ? memberRes.value.data.pagination?.total ?? memberRes.value.data.members.length : null,
    };
  }, [organizationId, billingEnabled]);

  const quotas = home.data?.quotas ?? null;
  const pendingInvites = home.data?.pendingInvites ?? 0;
  const memberCount = home.data?.memberCount ?? null;
  const compliance = home.data?.compliance ?? EMPTY_COMPLIANCE;
  const subscription = home.data?.subscription ?? null;
  const loading = home.loading;

  const blockedEntries = useMemo(
    () => compliance.filter((e) => e.result === 'block').slice(0, 3),
    [compliance],
  );

  return (
    <>
      {/* Quota health row — the most important admin-facing signal. */}
      <Card className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="h3 inline-flex items-center gap-1.5">
            <BarChart3 className="w-4 h-4 text-fg-subtle" />
            Quota health
          </h3>
          <div className="flex items-center gap-3">
            {/* The figures below are the ACCOUNT's pool in BOTH directions — a
                team draws on its parent's caps, and a parent's usage already
                includes every team's — so both states say so, rather than
                leaving a root admin to read them as its own members' numbers.
                One wording app-wide (see `poolingExplanation`); the full
                explanation lives on the Quotas and Members pages, where the
                decision is actually made. */}
            {isChildOrg || hasChildOrgs ? (
              <span className="text-xs text-fg-muted">{POOLING_TITLE}</span>
            ) : null}
            <Link href="/dashboard/quotas" className="action-link text-xs">Manage →</Link>
          </div>
        </div>
        {loading && !quotas && <LoadingSpinner size="sm" />}
        {quotas && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(Object.keys(QUOTA_LABELS) as DisplayedQuotaType[]).map((type) => {
              const q = quotas.quotas[type];
              if (!q) return null;
              const tone = quotaTone(q.used, q.limit, q.unlimited);
              const pct = q.unlimited || q.limit <= 0 ? null : Math.round((q.used / q.limit) * 100);
              return (
                <div key={type} className="rounded-lg border border-default px-3 py-2">
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="text-xs text-fg-muted">{QUOTA_LABELS[type]}</span>
                    {pct !== null && (
                      <Badge color={tone}>{pct}%</Badge>
                    )}
                    {pct === null && <Badge color="gray">unlimited</Badge>}
                  </div>
                  <div className="mt-1 text-xl font-semibold text-fg tabular-nums">
                    {fmtNum(q.used)}
                    {!q.unlimited && (
                      <span className="text-sm text-fg-subtle font-normal"> / {fmtNum(q.limit)}</span>
                    )}
                  </div>
                  <div className="text-2xs text-fg-muted mt-1">
                    resets <RelativeTime value={q.resetAt} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Team + compliance side-by-side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* Team / invitations */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h3 className="h3 inline-flex items-center gap-1.5">
              <Mail className="w-4 h-4 text-fg-subtle" />
              Members
            </h3>
            <Link href="/dashboard/members" className="action-link text-xs">Manage members →</Link>
          </div>
          {/* Inherited authority: this session has NO membership row here, so
              the roster below does not include the viewer and no seat is spent
              on them. Stated once, where the member count is, rather than
              letting the count imply they are on it. */}
          {viaAncestor && (
            <p className="mb-3 rounded-md bg-surface-muted px-3 py-2 text-xs text-fg-muted">
              You administer this team through {parentOrgName ?? 'its parent organization'} — you are not on its
              roster and use none of its seats.
            </p>
          )}
          <div className={`grid ${hasChildOrgs ? 'grid-cols-3' : 'grid-cols-2'} gap-3 text-sm`}>
            <div className="rounded-md bg-surface-muted px-3 py-2">
              <div className="text-xs text-fg-muted">Pending invitations</div>
              <div className={`mt-1 text-2xl font-semibold ${pendingInvites > 0 ? 'text-warning' : 'text-fg'}`}>
                {pendingInvites}
              </div>
              {pendingInvites > 0 && (
                <Link href="/dashboard/invitations" className="action-link text-xs inline-flex items-center gap-1 mt-1">
                  Review <ArrowRight className="w-3 h-3" />
                </Link>
              )}
            </div>
            <div className="rounded-md bg-surface-muted px-3 py-2">
              <div className="text-xs text-fg-muted">Members</div>
              <div className="mt-1 text-2xl font-semibold text-fg">
                {memberCount ?? '—'}
              </div>
            </div>
            {hasChildOrgs && (
              <div className="rounded-md bg-surface-muted px-3 py-2">
                <div className="text-xs text-fg-muted inline-flex items-center gap-1">
                  <Building2 className="w-3 h-3" aria-hidden="true" /> Teams
                </div>
                <div className="mt-1 text-2xl font-semibold text-fg">{childOrgCount}</div>
                <Link href="/dashboard/members" className="action-link text-xs inline-flex items-center gap-1 mt-1">
                  View <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            )}
          </div>
        </Card>

        {/* Compliance pulse */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h3 className="h3 inline-flex items-center gap-1.5">
              <Shield className="w-4 h-4 text-fg-subtle" />
              Compliance pulse
            </h3>
            <Link href="/dashboard/compliance" className="action-link text-xs">All rules →</Link>
          </div>
          {blockedEntries.length === 0 ? (
            <div className="rounded-md bg-success-bg px-3 py-3 text-sm text-success flex items-center gap-2">
              <Shield className="w-4 h-4" /> No recent compliance violations.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {blockedEntries.map((e) => (
                <li key={e.id} className="text-sm flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-fg truncate">
                      {complianceActionLabel(e.action, e.target)} blocked
                      {e.entityName && <span className="text-fg-muted"> — {e.entityName}</span>}
                    </div>
                    <div className="text-xs text-fg-muted">
                      <RelativeTime value={e.createdAt} />
                      {e.violations.length > 0 && <span> · {e.violations.length} violation{e.violations.length === 1 ? '' : 's'}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {canSeeOrgSecurity && organizationId && (
        <OrgSecurityCard orgId={organizationId} canReadIdp={hasPermission(user, 'org:idp')} />
      )}

      {/* Billing snapshot */}
      {subscription && (
        <Card className="mb-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="h3 inline-flex items-center gap-1.5">
              <CreditCard className="w-4 h-4 text-fg-subtle" />
              Billing
            </h3>
            {/* The subscription shown is the ACCOUNT's (billing pools at the
                root), and a team admin cannot change it — "Manage plan" would
                lead to controls the backend refuses. Say where the plan is
                managed and offer the read instead. */}
            {isChildOrg ? (
              <span className="text-xs text-fg-muted">
                Managed at {parentOrgName ?? 'the parent organization'} ·{' '}
                <Link href="/dashboard/billing" className="action-link">View plan →</Link>
              </span>
            ) : (
              <Link href="/dashboard/billing" className="action-link text-xs">Manage plan →</Link>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            <div className="rounded-md bg-surface-muted px-3 py-2">
              <div className="text-xs text-fg-muted">Plan</div>
              <div className="text-base font-medium text-fg">{subscription.planName || subscription.planId}</div>
            </div>
            <div className="rounded-md bg-surface-muted px-3 py-2">
              <div className="text-xs text-fg-muted">Status</div>
              <div className="text-base font-medium text-fg capitalize">
                {subscription.status}
                {subscription.cancelAtPeriodEnd && (
                  <Badge color="yellow">cancels at period end</Badge>
                )}
              </div>
            </div>
            <div className="rounded-md bg-surface-muted px-3 py-2">
              <div className="text-xs text-fg-muted">Next billing</div>
              <div className="text-base font-medium text-fg">
                <RelativeTime value={subscription.currentPeriodEnd} />
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Quick-links — common org-admin tasks */}
      <Card className="mb-4">
        <h3 className="h3 mb-3 inline-flex items-center gap-1.5">
          <Activity className="w-4 h-4 text-fg-subtle" />
          Common tasks
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <Link href="/dashboard/invitations" className="action-link">Invite members</Link>
          <Link href="/dashboard/members" className="action-link">Manage roles</Link>
          <Link href="/dashboard/quotas" className="action-link">Quotas</Link>
          {billingEnabled && (
            <Link href="/dashboard/billing" className="action-link">Billing</Link>
          )}
          <Link href="/dashboard/compliance" className="action-link">Compliance</Link>
          <Link href="/dashboard/observability/alert-destinations" className="action-link">Alert channels</Link>
          <Link href="/dashboard/executions" className="action-link">Executions</Link>
          <Link href="/dashboard/audit" className="action-link">Audit log</Link>
        </div>
      </Card>
    </>
  );
}
