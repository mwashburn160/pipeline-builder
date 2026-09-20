// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { useToast } from '@/components/ui/Toast';
import { Card } from '@/components/ui/Card';
import { RetryError } from '@/components/ui/RetryError';
import { formatError } from '@/lib/constants';
import type { OrgQuotaResponse, QuotaType, QuotaTier, DisplayedQuotaType, User } from '@/types';
import { QuotaCard } from './QuotaCard';
import { OrgListItem } from './OrgListItem';
import { CurrentTierPanel } from './CurrentTierPanel';
import { QUOTA_KEYS, TIER_KEYS, TIER_PRESETS, pillClassFor, type TierPreset } from './constants';

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
  tierPresets = TIER_PRESETS,
  dirty,
  saving,
  platformOrgs,
  filteredOrgs,
  orgTotal,
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
  onRetryOrg,
  fetchAtRisk,
  onResetUsage,
}: {
  isSuperAdmin: boolean;
  loading: boolean;
  orgData: OrgQuotaResponse | null;
  loadError: string | null;
  editTier: QuotaTier;
  editValues: Record<DisplayedQuotaType, number>;
  /** Effective per-tier presets (server-sourced, env-override-aware). Defaults to
   *  the hardcoded `TIER_PRESETS` fallback when the page hasn't threaded them. */
  tierPresets?: Record<QuotaTier, TierPreset>;
  dirty: boolean;
  saving: boolean;
  platformOrgs: { id: string; name: string; slug?: string }[];
  filteredOrgs: { id: string; name: string; slug?: string }[];
  /** Total org count on the server (>= platformOrgs.length when the picker is capped). */
  orgTotal: number;
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
  /** Re-read the selected org's quotas (the load-error Retry). */
  onRetryOrg: () => void;
  fetchAtRisk: () => void;
  /** Zero the selected org's usage counters mid-period. Rejects on failure so
   *  the confirm modal can surface the error and stay open. */
  onResetUsage: () => Promise<void>;
}) {
  const toast = useToast();
  // A TEAM's tier is inherited and its limits are pooled at the root (the quota
  // service rejects tier/limit writes to a team) — show it read-only with a
  // jump to the root instead of the editors.
  const pooledTeam = orgData?.pool && !orgData.pool.isRoot ? orgData.pool : null;
  const canEdit = isSuperAdmin && !pooledTeam;
  // Usage-reset confirm modal (sysadmin operational action).
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const doReset = async () => {
    setResetting(true);
    try {
      await onResetUsage();
      setResetOpen(false);
    } catch (err) {
      toast.error(formatError(err, 'Failed to reset usage'));
    } finally {
      setResetting(false);
    }
  };
  const titleExtra = !loading && orgData ? (
    <div className="hidden sm:flex items-center gap-2">
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300 font-mono">
        {orgData.orgId}
      </span>
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${pillClassFor(editTier)}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${tierPresets[editTier].color}`} />
        {tierPresets[editTier].label}
      </span>
      {orgData.pool && (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
          {orgData.pool.isRoot ? `Pool root · ${orgData.pool.orgCount - 1} team${orgData.pool.orgCount - 1 !== 1 ? 's' : ''}` : 'Team'}
        </span>
      )}
    </div>
  ) : undefined;

  const headerActions = isSuperAdmin && !loading ? (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        size="xs"
        onClick={() => setResetOpen(true)}
        disabled={!orgData}
        title="Zero this org's usage counters mid-period (limits are unchanged)"
      >
        Reset usage
      </Button>
      {canEdit && (
        <>
          <Button variant="secondary" size="xs" onClick={handleReset} disabled={!dirty}>
            Discard
          </Button>
          <Button size="xs" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? <><LoadingSpinner size="sm" className="mr-2" /> Saving...</> : 'Save'}
          </Button>
        </>
      )}
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
              <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
                Organizations
              </p>
              <Input
                type="text"
                placeholder="Filter..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="!py-1.5 text-xs"
              />
              <p className="text-xs text-fg-subtle mt-2">
                {orgTotal > platformOrgs.length
                  ? `Showing ${platformOrgs.length} of ${orgTotal} — type to search all`
                  : `${platformOrgs.length} org${platformOrgs.length !== 1 ? 's' : ''}`}
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
                <p className="p-5 text-sm text-fg-subtle text-center">No matches</p>
              )}
            </div>
          </div>
        )}

        {/* Main content */}
        <div className="flex-1 overflow-y-auto p-6 lg:p-8">
          <div className="max-w-4xl">
            {loadError && !loading && (
              <RetryError message={loadError} onRetry={onRetryOrg} className="mb-6" />
            )}
            {/* At-risk orgs banner — sysadmin only. Click an entry to jump
                to that org in the sidebar. Hidden when no orgs are at risk. */}
            {isSuperAdmin && atRisk.length > 0 && (
              <div className="mb-6 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                    {atRisk.length} org{atRisk.length !== 1 ? 's' : ''} at risk (≥80% on a quota)
                  </h3>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={fetchAtRisk}
                    className="text-xs text-amber-800 dark:text-amber-200 underline hover:no-underline"
                  >
                    Refresh
                  </Button>
                </div>
                <ul className="space-y-1">
                  {atRisk.slice(0, 10).map((entry) => (
                    <li key={`${entry.orgId}:${entry.type}`} className="text-sm">
                      <Button
                        variant="link"
                        onClick={() => handleSelectOrg(entry.orgId)}
                        className="text-amber-900 dark:text-amber-100"
                      >
                        <span className="font-medium">{entry.name}</span>
                        <span className="ml-2 text-amber-700 dark:text-amber-300">
                          {entry.type} {entry.percent}% ({entry.used}/{entry.limit})
                        </span>
                      </Button>
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
              <p className="text-sm text-fg-muted mb-4">
                {orgData.name} &middot; <span className="font-mono">{orgData.slug}</span>
              </p>
            )}

            {!loading && pooledTeam && (
              <div className="mb-6 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4" role="note">
                <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-1">
                  Pooled at {pooledTeam.rootOrgName || pooledTeam.rootOrgId}
                </h3>
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  This is a team. Its tier is inherited and its limits are the root organization&apos;s shared caps; the
                  usage shown is the combined total across the root and all {pooledTeam.orgCount - 1} of its teams. Change
                  the tier or limits on the root organization.
                </p>
                <Button
                  variant="link"
                  onClick={() => handleSelectOrg(pooledTeam.rootOrgId)}
                  className="mt-2 text-sm font-medium"
                >
                  View {pooledTeam.rootOrgName || pooledTeam.rootOrgId}&apos;s quotas
                </Button>
              </div>
            )}
            {!loading && orgData?.pool?.isRoot && isSuperAdmin && (
              <p className="mb-4 text-xs text-fg-muted">
                Pooled across this organization and its {orgData.pool.orgCount - 1} team{orgData.pool.orgCount - 1 !== 1 ? 's' : ''}:
                usage is the combined total, and these limits bind all of them.
              </p>
            )}

            {/* Always-correct current tier — includes tiers (e.g. `unlimited`)
                that the selector below never highlights. */}
            {!loading && orgData && (
              <CurrentTierPanel
                tier={orgData.tier || 'developer'}
                pendingTier={editTier}
                selectorBelow={canEdit}
              />
            )}

            {/* Tier selector — system admin only, never for a pooled team */}
            {!loading && orgData && canEdit && (
              <div className="mb-8">
                <div className="mb-3">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                    Change plan tier
                  </h2>
                  <p className="mt-1 text-xs text-fg-subtle">
                    Selecting a tier fills in its preset limits below. Save to apply.
                  </p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {TIER_KEYS.map((tier) => {
                    const preset = tierPresets[tier];
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
                        <p className="text-xs text-fg-muted">{preset.description}</p>
                        <div className="mt-2 text-xs text-fg-subtle tabular-nums">
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
              <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
                Quota Usage
                {canEdit && (
                  <span className="font-normal normal-case tracking-normal ml-2 text-fg-subtle">
                    — edit each limit in its card
                  </span>
                )}
              </h2>

              {loading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {[0, 1, 2, 3].map((i) => (
                    <Card key={i}>
                      <div className="h-4 skeleton w-1/2 mb-4" />
                      <div className="h-8 skeleton w-1/3 mb-3" />
                      <div className="h-1.5 skeleton rounded-full mb-3" />
                      <div className="h-3 skeleton w-2/3" />
                    </Card>
                  ))}
                </div>
              ) : orgData ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {QUOTA_KEYS.map((key) => (
                    <QuotaCard
                      key={key}
                      quotaKey={key}
                      quota={orgData.quotas[key]}
                      canManage={canEdit}
                      editVal={editValues[key]}
                      onEditChange={handleEditChange}
                    />
                  ))}
                </div>
              ) : null}
            </div>

            {!isSuperAdmin && !loading && (
              <p className="text-sm text-fg-subtle text-center mt-6">
                Contact a system administrator to change quota limits.
              </p>
            )}
          </div>
        </div>
      </div>

      {resetOpen && orgData && (
        <Modal
          title="Reset usage counters"
          onClose={() => !resetting && setResetOpen(false)}
          footer={
            <ModalFooter
              onCancel={() => setResetOpen(false)}
              onConfirm={doReset}
              confirmLabel="Reset usage"
              confirmVariant="danger"
              loading={resetting}
            />
          }
        >
          <div className="space-y-3 text-sm text-gray-600 dark:text-gray-300">
            <p>
              This zeroes every usage counter for{' '}
              <span className="font-medium text-gray-900 dark:text-gray-100">{orgData.name}</span>{' '}
              (<span className="font-mono text-xs">{orgData.orgId}</span>) immediately,
              before the natural period reset. Quota <strong>limits</strong> and tier are
              left unchanged.
            </p>
            <p className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              This is an operational reset that affects what the org can consume this
              period. It is audit-logged and cannot be undone.
            </p>
          </div>
        </Modal>
      )}

    </DashboardLayout>
  );
}
