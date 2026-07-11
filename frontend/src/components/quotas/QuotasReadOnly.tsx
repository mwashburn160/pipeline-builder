// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DashboardLayout } from '@/components/ui/DashboardLayout';
import type { OrgQuotaResponse } from '@/types';
import { QuotaCard } from './QuotaCard';
import { QUOTA_KEYS, TIER_PRESETS } from './constants';

/**
 * Read-only quota view for regular (non-superadmin) users. Shows the active
 * org's tier badge and its quota usage cards; all editing affordances are off.
 */
export function QuotasReadOnly({
  orgData,
  loading,
  activeOrgIsTeam,
}: {
  orgData: OrgQuotaResponse | null;
  loading: boolean;
  activeOrgIsTeam: boolean;
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
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center mt-6">
          {activeOrgIsTeam
            ? 'These pooled limits are managed by an admin at the parent organization.'
            : 'Contact a system administrator to change quota limits.'}
        </p>
      </div>
    </DashboardLayout>
  );
}
