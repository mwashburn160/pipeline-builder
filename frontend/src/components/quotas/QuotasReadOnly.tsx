// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import type { OrgQuotaResponse, DisplayedQuotaType } from '@/types';
import { QuotaCard } from './QuotaCard';
import { QUOTA_KEYS, QUOTA_META, TIER_PRESETS } from './constants';

/** One at-risk quota dimension for the caller's own org (from `getOrgAtRisk`). */
export interface AtRiskDimension {
  type: DisplayedQuotaType;
  used: number;
  limit: number;
  percent: number;
}

/**
 * Read-only quota view for regular (non-superadmin) users. Shows the active
 * org's tier badge and its quota usage cards; all editing affordances are off.
 */
export function QuotasReadOnly({
  orgData,
  loading,
  activeOrgIsTeam,
  canManageBilling,
  atRisk = [],
}: {
  orgData: OrgQuotaResponse | null;
  loading: boolean;
  activeOrgIsTeam: boolean;
  /** Viewer can act on billing (owner/admin or `billing:manage`) → offer the
   *  upgrade path instead of "contact a sysadmin". */
  canManageBilling: boolean;
  /** Own-org quota dimensions at/above the at-risk threshold — surfaced as an
   *  "approaching limit" callout for org admins/owners. Empty ⇒ nothing shown. */
  atRisk?: AtRiskDimension[];
}) {
  const tier = orgData?.tier || 'developer';
  const tierPreset = TIER_PRESETS[tier];
  return (
    <DashboardLayout
      title="Quotas"
      subtitle="Usage limits and consumption"
      titleExtra={orgData ? (
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
          tier === 'enterprise'
            ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-300'
            : tier === 'pro'
              ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300'
              : tier === 'team'
                ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300'
                : 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${tierPreset.color}`} />
          {tierPreset.label}
        </span>
      ) : undefined}
    >
      <div className="page-section max-w-4xl">
        {atRisk.length > 0 && (
          <div className="mb-6 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4">
            <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100 mb-2 inline-flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" aria-hidden="true" />
              Approaching your limits
            </h3>
            <ul className="space-y-1 text-sm text-amber-800 dark:text-amber-200">
              {atRisk.map((d) => (
                <li key={d.type} className="flex items-baseline justify-between gap-2">
                  <span>{QUOTA_META[d.type]?.label ?? d.type}</span>
                  <span className="tabular-nums whitespace-nowrap">
                    {d.used.toLocaleString()} / {d.limit.toLocaleString()}
                    <span className="ml-2 font-medium">({d.percent}%)</span>
                  </span>
                </li>
              ))}
            </ul>
            {!activeOrgIsTeam && canManageBilling && (
              <p className="mt-3 text-sm text-amber-800 dark:text-amber-200">
                <Link href="/dashboard/billing" className="action-link font-medium">Upgrade your plan</Link>{' '}
                to raise these limits before you hit them.
              </p>
            )}
          </div>
        )}
        {activeOrgIsTeam && (
          <div className="mb-6 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4">
            <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-1">Pooled across your organization</h3>
            <p className="text-sm text-blue-800 dark:text-blue-200">
              This is a team. The limits below are your organization&apos;s shared caps, and the usage shown is the combined
              total across all of its teams. Limits are managed by an admin at the parent organization.
            </p>
          </div>
        )}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="card">
                <div className="h-4 skeleton w-1/2 mb-4" />
                <div className="h-8 skeleton w-1/3 mb-3" />
                <div className="h-1.5 skeleton rounded-full mb-3" />
                <div className="h-3 skeleton w-2/3" />
              </div>
            ))}
          </div>
        ) : orgData ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {QUOTA_KEYS.map((key) => (
              <QuotaCard
                key={key}
                quotaKey={key}
                quota={orgData.quotas[key]}
                isAdmin={false}
                editVal={orgData.quotas[key].limit}
                onEditChange={() => {}}
              />
            ))}
          </div>
        ) : null}
        {activeOrgIsTeam ? (
          // A team's caps are the root's — the sysadmin/upgrade path lives at the parent.
          <p className="text-sm text-gray-400 dark:text-gray-500 text-center mt-6">
            These pooled limits are managed by an admin at the parent organization.
          </p>
        ) : canManageBilling ? (
          // The viewer can act on billing: point them at the upgrade path, not a sysadmin.
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center mt-6">
            Need more capacity?{' '}
            <Link href="/dashboard/billing" className="action-link font-medium">Upgrade your plan</Link>{' '}
            to raise these limits.
          </p>
        ) : (
          // Hard quota caps that billing can't lift for this viewer → sysadmin.
          <p className="text-sm text-gray-400 dark:text-gray-500 text-center mt-6">
            Contact a system administrator to change quota limits.
          </p>
        )}
      </div>
    </DashboardLayout>
  );
}
