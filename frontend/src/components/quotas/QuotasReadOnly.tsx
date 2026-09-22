// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { RetryError } from '@/components/ui/RetryError';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import type { OrgQuotaResponse, QuotaType } from '@/types';
import { QUOTA_TYPE_LABEL } from '@/lib/quota-pressure';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { fmtNum } from '@/lib/format';
import { QUOTA_WARNING_THRESHOLD } from '@/lib/constants';
import { getTierMeta } from '@/lib/tiers';
import { QuotaCard } from './QuotaCard';
import { CurrentTierPanel } from './CurrentTierPanel';
import { AT_RISK_THRESHOLDS, QUOTA_KEYS, TIER_PRESETS, POOLING_TITLE, poolingExplanation } from './constants';

/** One at-risk quota dimension for the caller's own org (from `getOrgAtRisk`). */
export interface AtRiskDimension {
  /** The FULL backend `QuotaType`: the at-risk scan iterates every dimension,
   *  not just the four the cards below display. */
  type: QuotaType;
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
  loadError = null,
  onRetry,
  activeOrgIsTeam,
  activeOrgHasTeams = false,
  canManageBilling,
  atRisk = [],
  atRiskThreshold = QUOTA_WARNING_THRESHOLD,
  setAtRiskThreshold,
}: {
  orgData: OrgQuotaResponse | null;
  loading: boolean;
  /** Set when the quota fetch failed — renders a retryable error instead of a
   *  blank page. */
  loadError?: string | null;
  /** Re-run the quota fetch. */
  onRetry?: () => void;
  activeOrgIsTeam: boolean;
  /** The active org is a root with teams: its numbers are the pool it shares
   *  with them (the same figures each team sees). */
  activeOrgHasTeams?: boolean;
  /** Viewer can act on billing (owner/admin or `billing:manage`) → offer the
   *  upgrade path instead of "contact a sysadmin". */
  canManageBilling: boolean;
  /** Own-org quota dimensions at/above the at-risk threshold — surfaced as an
   *  "approaching limit" callout for org admins/owners. Empty ⇒ nothing shown. */
  atRisk?: AtRiskDimension[];
  /** The percentage cut-off the callout is asking about (100 = exhausted).
   *  Defaults to the shared warning threshold when a caller does not own it. */
  atRiskThreshold?: number;
  /** Omitted when the caller holds no cut-off state — the picker is then not
   *  rendered rather than rendered inert. */
  setAtRiskThreshold?: (threshold: number) => void;
}) {
  const tier = orgData?.tier || 'developer';
  const tierPreset = TIER_PRESETS[tier];
  return (
    <DashboardLayout
      title="Quotas"
      subtitle="Usage limits and consumption"
      titleExtra={orgData ? (
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${getTierMeta(tier).pillClass}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${tierPreset.color}`} />
          {tierPreset.label}
        </span>
      ) : undefined}
    >
      <div className="page-section max-w-4xl">
        {(atRisk.length > 0 || atRiskThreshold >= 100) && (
          <div className="mb-6 rounded-lg border border-warning-border bg-warning-bg p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h3 className="text-sm font-semibold text-warning-strong inline-flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" aria-hidden="true" />
                {atRiskThreshold >= 100 ? 'Limits you have used up' : 'Approaching your limits'}
              </h3>
              {/* The per-org endpoint takes the same `threshold` the sysadmin
                  view does — "show what I have already used up" is one step. */}
              {setAtRiskThreshold && (
                <FilterSelect
                  aria-label="At-risk threshold"
                  value={atRiskThreshold}
                  onChange={(e) => setAtRiskThreshold(Number(e.target.value))}
                  className="text-xs"
                >
                  {AT_RISK_THRESHOLDS.map((t) => (
                    <option key={t} value={t}>{t >= 100 ? 'Used up' : `≥${t}%`}</option>
                  ))}
                </FilterSelect>
              )}
            </div>
            {atRisk.length === 0 && (
              <p className="text-sm text-warning-strong">Nothing is used up yet.</p>
            )}
            <ul className="space-y-1 text-sm text-warning-strong">
              {atRisk.map((d) => (
                <li key={d.type} className="flex items-baseline justify-between gap-2">
                  <span>{QUOTA_TYPE_LABEL[d.type] ?? d.type}</span>
                  <span className="tabular-nums whitespace-nowrap">
                    {fmtNum(d.used)} / {fmtNum(d.limit)}
                    <span className="ml-2 font-medium">({d.percent}%)</span>
                  </span>
                </li>
              ))}
            </ul>
            {!activeOrgIsTeam && canManageBilling && (
              <p className="mt-3 text-sm text-warning-strong">
                <Link href="/dashboard/billing" className="action-link font-medium">Upgrade your plan</Link>{' '}
                to raise these limits before you hit them.
              </p>
            )}
          </div>
        )}
        {/* One pooling explanation, one wording — see `poolingExplanation`. */}
        {activeOrgIsTeam && (
          <div className="mb-6 rounded-lg border border-info-border bg-info-bg p-4">
            <h3 className="text-sm font-semibold text-info-strong mb-1">{POOLING_TITLE}</h3>
            <p className="text-sm text-info-strong">
              This is a team. {poolingExplanation('team', orgData?.pool?.rootOrgName || undefined)}{' '}
              The limits are managed by an admin at the root organization.
            </p>
          </div>
        )}
        {activeOrgHasTeams && !activeOrgIsTeam && (
          <div className="mb-6 rounded-lg border border-info-border bg-info-bg p-4">
            <h3 className="text-sm font-semibold text-info-strong mb-1">{POOLING_TITLE}</h3>
            <p className="text-sm text-info-strong">
              {poolingExplanation('root', orgData?.name, orgData?.pool ? orgData.pool.orgCount - 1 : undefined)}
            </p>
          </div>
        )}
        {!loading && loadError && !orgData && (
          onRetry
            ? <RetryError message={loadError} onRetry={onRetry} className="mb-6" />
            : <ErrorAlert message={loadError} className="mb-6" />
        )}
        {!loading && orgData && <CurrentTierPanel tier={tier} />}
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
                canManage={false}
                editVal={orgData.quotas[key].limit}
                onEditChange={() => {}}
              />
            ))}
          </div>
        ) : null}
        {loadError && !orgData ? null : activeOrgIsTeam ? (
          // A team's caps are the root's — the sysadmin/upgrade path lives at the parent.
          <p className="text-sm text-fg-subtle text-center mt-6">
            These pooled limits are managed by an admin at the parent organization.
          </p>
        ) : canManageBilling ? (
          // The viewer can act on billing: point them at the upgrade path, not a sysadmin.
          <p className="text-sm text-fg-muted text-center mt-6">
            Need more capacity?{' '}
            <Link href="/dashboard/billing" className="action-link font-medium">Upgrade your plan</Link>{' '}
            to raise these limits.
          </p>
        ) : (
          // Hard quota caps that billing can't lift for this viewer → sysadmin.
          <p className="text-sm text-fg-subtle text-center mt-6">
            Contact a system administrator to change quota limits.
          </p>
        )}
      </div>
    </DashboardLayout>
  );
}
