// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { OrgQuotaResponse, QuotaType, QuotaTier, DisplayedQuotaType, User } from '@/types';
import { QuotaCard } from './QuotaCard';
import { OrgListItem } from './OrgListItem';
import { QUOTA_KEYS, TIER_KEYS, TIER_PRESETS } from './constants';

/**
 * System-admin master-detail quota view: an org sidebar plus the selected org's
 * tier selector, quota cards (with inline limit editing), and at-risk banner.
 * All data/state is owned by the page and threaded in via props.
 */
export function QuotasAdmin({
  isSuperAdmin,
  loading,
  orgData,
  loadError,
  editTier,
  editValues,
  dirty,
  saving,
  platformOrgs,
  filteredOrgs,
  searchFilter,
  selectedOrgId,
  orgHealthColors,
  atRisk,
  user,
  setSearchFilter,
  handleSelectOrg,
  handleReset,
  handleSave,
  handleEditChange,
  handleTierChange,
  fetchOrg,
  fetchAtRisk,
}: {
  isSuperAdmin: boolean;
  loading: boolean;
  orgData: OrgQuotaResponse | null;
  loadError: string | null;
  editTier: QuotaTier;
  editValues: Record<DisplayedQuotaType, number>;
  dirty: boolean;
  saving: boolean;
  platformOrgs: { id: string; name: string; slug?: string }[];
  filteredOrgs: { id: string; name: string; slug?: string }[];
  searchFilter: string;
  selectedOrgId: string | null;
  orgHealthColors: Record<string, string>;
  atRisk: Array<{
    orgId: string;
    name: string;
    type: QuotaType;
    used: number;
    limit: number;
    percent: number;
  }>;
  user: User | null;
  setSearchFilter: (value: string) => void;
  handleSelectOrg: (orgId: string) => void;
  handleReset: () => void;
  handleSave: () => void;
  handleEditChange: (key: DisplayedQuotaType, value: number) => void;
  handleTierChange: (tier: QuotaTier) => void;
  fetchOrg: (orgId: string) => void;
  fetchAtRisk: () => void;
}) {
  const titleExtra = !loading && orgData ? (
    <div className="hidden sm:flex items-center gap-2">
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300 font-mono">
        {orgData.orgId}
      </span>
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
        editTier === 'enterprise'
          ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-300'
          : editTier === 'pro'
            ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300'
            : editTier === 'team'
              ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300'
              : 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300'
      }`}>
        <span className={`w-1.5 h-1.5 rounded-full ${TIER_PRESETS[editTier].color}`} />
        {TIER_PRESETS[editTier].label}
      </span>
    </div>
  ) : undefined;

  const headerActions = isSuperAdmin && !loading ? (
    <div className="flex items-center gap-2">
      <Button variant="secondary" size="xs" onClick={handleReset} disabled={!dirty}>
        Discard
      </Button>
      <Button size="xs" onClick={handleSave} disabled={!dirty || saving}>
        {saving ? <><LoadingSpinner size="sm" className="mr-2" /> Saving...</> : 'Save'}
      </Button>
    </div>
  ) : undefined;

  return (
    <DashboardLayout
      title={isSuperAdmin ? 'Organization Quotas' : 'Quotas'}
      subtitle="Usage limits and consumption"
      titleExtra={titleExtra}
      actions={headerActions}
      mainClassName="!p-0"
    >
      <div className="flex min-h-[calc(100vh-theme(spacing.16))]">
        {/* Internal org sidebar (sysadmin only) */}
        {isSuperAdmin && (
          <div className="w-64 min-w-[16rem] border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col">
            <div className="p-4 border-b border-gray-200 dark:border-gray-700">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-3">
                Organizations
              </p>
              <Input
                type="text"
                placeholder="Filter..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="!py-1.5 text-xs"
              />
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                {platformOrgs.length} org{platformOrgs.length !== 1 ? 's' : ''}
              </p>
            </div>
            <div className="flex-1 overflow-y-auto">
              {filteredOrgs.map((org) => (
                <OrgListItem
                  key={org.id}
                  org={org}
                  selected={org.id === selectedOrgId}
                  healthColor={orgHealthColors[org.id]}
                  onClick={() => handleSelectOrg(org.id)}
                />
              ))}
              {filteredOrgs.length === 0 && (
                <p className="p-5 text-sm text-gray-400 dark:text-gray-500 text-center">No matches</p>
              )}
            </div>
          </div>
        )}

        {/* Main content */}
        <div className="flex-1 overflow-y-auto p-6 lg:p-8">
          <div className="max-w-4xl">
            {loadError && !loading && (
              <div className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300">
                <span>{loadError}</span>
                <button
                  type="button"
                  onClick={() => { const o = isSuperAdmin ? selectedOrgId : user?.organizationId; if (o) fetchOrg(o); }}
                  className="underline hover:no-underline"
                >Retry</button>
              </div>
            )}
            {/* At-risk orgs banner — sysadmin only. Click an entry to jump
                to that org in the sidebar. Hidden when no orgs are at risk. */}
            {isSuperAdmin && atRisk.length > 0 && (
              <div className="mb-6 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                    {atRisk.length} org{atRisk.length !== 1 ? 's' : ''} at risk (≥80% on a quota)
                  </h3>
                  <button
                    type="button"
                    onClick={fetchAtRisk}
                    className="text-xs text-amber-800 dark:text-amber-200 underline hover:no-underline"
                  >
                    Refresh
                  </button>
                </div>
                <ul className="space-y-1">
                  {atRisk.slice(0, 10).map((entry) => (
                    <li key={`${entry.orgId}:${entry.type}`} className="text-sm">
                      <button
                        type="button"
                        onClick={() => handleSelectOrg(entry.orgId)}
                        className="text-amber-900 dark:text-amber-100 hover:underline"
                      >
                        <span className="font-medium">{entry.name}</span>
                        <span className="ml-2 text-amber-700 dark:text-amber-300">
                          {entry.type} {entry.percent}% ({entry.used}/{entry.limit})
                        </span>
                      </button>
                    </li>
                  ))}
                  {atRisk.length > 10 && (
                    <li className="text-xs text-amber-700 dark:text-amber-300">
                      …and {atRisk.length - 10} more
                    </li>
                  )}
                </ul>
              </div>
            )}

            {!loading && orgData && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                {orgData.name} &middot; <span className="font-mono">{orgData.slug}</span>
              </p>
            )}

            {/* Tier selector — system admin only */}
            {!loading && orgData && isSuperAdmin && (
              <div className="mb-8">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-3">
                  Plan Tier
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {TIER_KEYS.map((tier) => {
                    const preset = TIER_PRESETS[tier];
                    const isSelected = editTier === tier;
                    return (
                      <button
                        key={tier}
                        type="button"
                        disabled={!isSuperAdmin}
                        onClick={() => isSuperAdmin && handleTierChange(tier)}
                        className={`relative card text-left transition-all ${
                          isSelected
                            ? 'ring-2 ring-blue-500 dark:ring-blue-400 border-blue-300 dark:border-blue-600'
                            : isSuperAdmin
                              ? 'hover:border-gray-300 dark:hover:border-gray-600 cursor-pointer'
                              : 'opacity-60'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`w-2.5 h-2.5 rounded-full ${preset.color}`} />
                          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{preset.label}</span>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{preset.description}</p>
                        <div className="mt-2 text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                          {preset.limits.pipelines === -1 ? 'Unlimited' : preset.limits.pipelines} pipelines
                          {' / '}
                          {preset.limits.plugins === -1 ? 'Unlimited' : preset.limits.plugins} plugins
                        </div>
                        {isSelected && (
                          <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-blue-500" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mb-8">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-3">
                Quota Usage
                {isSuperAdmin && (
                  <span className="font-normal normal-case tracking-normal ml-2 text-gray-400 dark:text-gray-500">
                    — edit limits below each card
                  </span>
                )}
              </h2>

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
                      isAdmin={isSuperAdmin}
                      editVal={editValues[key]}
                      onEditChange={handleEditChange}
                    />
                  ))}
                </div>
              ) : null}
            </div>

            {!isSuperAdmin && !loading && (
              <p className="text-sm text-gray-400 dark:text-gray-500 text-center mt-6">
                Contact a system administrator to change quota limits.
              </p>
            )}
          </div>
        </div>
      </div>

    </DashboardLayout>
  );
}
