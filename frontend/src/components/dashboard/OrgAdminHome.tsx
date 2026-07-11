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
 *   2. Pending invitations + member count
 *   3. Compliance pulse — last 3 blocked entries (if any)
 *   4. Billing snapshot — current plan + period days elapsed
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  BarChart3, Mail, Shield, CreditCard, AlertTriangle, Activity, ArrowRight,
} from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useFeatures } from '@/hooks/useFeatures';
import api from '@/lib/api';
import type { OrgQuotaResponse, DisplayedQuotaType, Subscription } from '@/types';
import type { ComplianceAuditEntry } from '@/types/compliance';

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
  const [quotas, setQuotas] = useState<OrgQuotaResponse | null>(null);
  const [pendingInvites, setPendingInvites] = useState<number>(0);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [compliance, setCompliance] = useState<ComplianceAuditEntry[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Each call is independent and best-effort — missing data degrades to
    // an empty section rather than blocking the whole page. The
    // memberCount fetch is conditional on having an org id; cross-org
    // sysadmin sessions hit this path without one and we skip the call.
    // The subscription fetch is gated on the `billing` feature flag served
    // from /api/config — when billing is disabled we skip the call entirely
    // so we don't pile up 503s from a deliberately-disabled service.
    const memberPromise = organizationId
      ? api.getOrganizationMembers(organizationId).catch(() => null)
      : Promise.resolve(null);
    const subscriptionPromise = billingEnabled
      ? api.getSubscription().catch(() => null)
      : Promise.resolve(null);

    Promise.allSettled([
      api.getOwnQuotas(),
      api.listInvitations({ status: 'pending', limit: 1 }),
      api.getComplianceAuditLog({ limit: 5 }),
      subscriptionPromise,
      memberPromise,
    ]).then(([quotaRes, inviteRes, complianceRes, subRes, memberRes]) => {
      if (cancelled) return;
      if (quotaRes.status === 'fulfilled' && quotaRes.value.success && quotaRes.value.data) {
        // api.getOwnQuotas returns `{ quota: OrgQuotaResponse }`; use that
        // canonical shape directly rather than the previous `q.quota ?? q`
        // fallback that masked envelope-vs-bare shape drift.
        setQuotas(quotaRes.value.data.quota);
      }
      if (inviteRes.status === 'fulfilled' && inviteRes.value.success && inviteRes.value.data) {
        setPendingInvites(inviteRes.value.data.pagination?.total ?? inviteRes.value.data.invitations.length);
      }
      if (complianceRes.status === 'fulfilled' && complianceRes.value.success && complianceRes.value.data) {
        setCompliance(complianceRes.value.data.entries);
      }
      if (subRes.status === 'fulfilled' && subRes.value && subRes.value.success && subRes.value.data) {
        setSubscription(subRes.value.data.subscription);
      }
      if (memberRes.status === 'fulfilled' && memberRes.value && memberRes.value.success && memberRes.value.data) {
        setMemberCount(memberRes.value.data.members.length);
      }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [organizationId, billingEnabled]);

  const blockedEntries = useMemo(
    () => compliance.filter((e) => e.result === 'block').slice(0, 3),
    [compliance],
  );

  return (
    <>
      {/* Quota health row — the most important admin-facing signal. */}
      <div className="card mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
            <BarChart3 className="w-4 h-4 text-gray-400" />
            Quota health
          </h3>
          <Link href="/dashboard/quotas" className="action-link text-xs">Manage →</Link>
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
                <div key={type} className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="text-xs text-gray-500 dark:text-gray-400">{QUOTA_LABELS[type]}</span>
                    {pct !== null && (
                      <Badge color={tone}>{pct}%</Badge>
                    )}
                    {pct === null && <Badge color="gray">unlimited</Badge>}
                  </div>
                  <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                    {q.used.toLocaleString()}
                    {!q.unlimited && (
                      <span className="text-sm text-gray-400 dark:text-gray-500 font-normal"> / {q.limit.toLocaleString()}</span>
                    )}
                  </div>
                  <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">
                    resets <RelativeTime value={q.resetAt} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Team + compliance side-by-side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* Team / invitations */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
              <Mail className="w-4 h-4 text-gray-400" />
              Team
            </h3>
            <Link href="/dashboard/members" className="action-link text-xs">Manage members →</Link>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md bg-gray-50 dark:bg-gray-800/50 px-3 py-2">
              <div className="text-xs text-gray-500 dark:text-gray-400">Pending invitations</div>
              <div className={`mt-1 text-2xl font-semibold ${pendingInvites > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-gray-100'}`}>
                {pendingInvites}
              </div>
              {pendingInvites > 0 && (
                <Link href="/dashboard/invitations" className="action-link text-xs inline-flex items-center gap-1 mt-1">
                  Review <ArrowRight className="w-3 h-3" />
                </Link>
              )}
            </div>
            <div className="rounded-md bg-gray-50 dark:bg-gray-800/50 px-3 py-2">
              <div className="text-xs text-gray-500 dark:text-gray-400">Members</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {memberCount ?? '—'}
              </div>
            </div>
          </div>
        </div>

        {/* Compliance pulse */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
              <Shield className="w-4 h-4 text-gray-400" />
              Compliance pulse
            </h3>
            <Link href="/dashboard/compliance" className="action-link text-xs">All rules →</Link>
          </div>
          {blockedEntries.length === 0 ? (
            <div className="rounded-md bg-green-50 dark:bg-green-900/20 px-3 py-3 text-sm text-green-700 dark:text-green-300 flex items-center gap-2">
              <Shield className="w-4 h-4" /> No recent compliance violations.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {blockedEntries.map((e) => (
                <li key={e.id} className="text-sm flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-gray-800 dark:text-gray-200 truncate">
                      <code className="text-xs">{e.action}</code>
                      {e.entityName && <span className="text-gray-500 dark:text-gray-400"> on {e.entityName}</span>}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      <RelativeTime value={e.createdAt} />
                      {e.violations.length > 0 && <span> · {e.violations.length} violation{e.violations.length === 1 ? '' : 's'}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Billing snapshot */}
      {subscription && (
        <div className="card mb-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
              <CreditCard className="w-4 h-4 text-gray-400" />
              Billing
            </h3>
            <Link href="/dashboard/billing" className="action-link text-xs">Manage plan →</Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            <div className="rounded-md bg-gray-50 dark:bg-gray-800/50 px-3 py-2">
              <div className="text-xs text-gray-500 dark:text-gray-400">Plan</div>
              <div className="text-base font-medium text-gray-900 dark:text-gray-100">{subscription.planName || subscription.planId}</div>
            </div>
            <div className="rounded-md bg-gray-50 dark:bg-gray-800/50 px-3 py-2">
              <div className="text-xs text-gray-500 dark:text-gray-400">Status</div>
              <div className="text-base font-medium text-gray-900 dark:text-gray-100 capitalize">
                {subscription.status}
                {subscription.cancelAtPeriodEnd && (
                  <Badge color="yellow">cancels at period end</Badge>
                )}
              </div>
            </div>
            <div className="rounded-md bg-gray-50 dark:bg-gray-800/50 px-3 py-2">
              <div className="text-xs text-gray-500 dark:text-gray-400">Next billing</div>
              <div className="text-base font-medium text-gray-900 dark:text-gray-100">
                <RelativeTime value={subscription.currentPeriodEnd} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quick-links — common org-admin tasks */}
      <div className="card mb-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3 inline-flex items-center gap-1.5">
          <Activity className="w-4 h-4 text-gray-400" />
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
      </div>
    </>
  );
}
