import { useEffect, useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { useToast } from '@/components/ui/Toast';
import { pct, fmtNum, daysUntil, statusInfo, statusStyles, barStyles, overallHealthColor } from '@/lib/quota-helpers';
import { TIER_META, TIER_KEYS as SHARED_TIER_KEYS } from '@/lib/tiers';
import type { OrgQuotaResponse, QuotaType, QuotaTier } from '@/types';
import api from '@/lib/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUOTA_KEYS: QuotaType[] = ['plugins', 'pipelines', 'apiCalls', 'aiCalls'];

const QUOTA_META: Record<QuotaType, { label: string; description: string }> = {
  plugins: { label: 'Plugins', description: 'Container images deployed' },
  pipelines: { label: 'Pipelines', description: 'Pipeline configurations' },
  apiCalls: { label: 'API Calls', description: 'Requests this period' },
  aiCalls: { label: 'AI Calls', description: 'AI generation invocations this period' },
};

const TIER_KEYS: QuotaTier[] = [...SHARED_TIER_KEYS];

// Tier descriptions + quota limits stay local — they're page-specific and
// not appropriate for the shared TIER_META catalog. Label and dot color
// now come from TIER_META so renames stay in one place.
const TIER_DESCRIPTIONS: Record<QuotaTier, string> = {
  developer: 'Starter tier',
  pro: 'Production use',
  team: 'Team collaboration',
  enterprise: 'No restrictions',
};

const TIER_LIMITS: Record<QuotaTier, Record<QuotaType, number>> = {
  developer: { pipelines: 5, plugins: 50, apiCalls: 25000, aiCalls: 50 },
  pro: { pipelines: 50, plugins: 500, apiCalls: 500000, aiCalls: 2500 },
  team: { pipelines: 200, plugins: 2000, apiCalls: -1, aiCalls: 10000 },
  enterprise: { pipelines: 500, plugins: 5000, apiCalls: -1, aiCalls: 25000 },
};

const TIER_PRESETS: Record<QuotaTier, { label: string; description: string; color: string; limits: Record<QuotaType, number> }> = {
  developer:  { label: TIER_META.developer.label,  description: TIER_DESCRIPTIONS.developer,  color: TIER_META.developer.dotClass,  limits: TIER_LIMITS.developer },
  pro:        { label: TIER_META.pro.label,        description: TIER_DESCRIPTIONS.pro,        color: TIER_META.pro.dotClass,        limits: TIER_LIMITS.pro },
  team:       { label: TIER_META.team.label,       description: TIER_DESCRIPTIONS.team,       color: TIER_META.team.dotClass,       limits: TIER_LIMITS.team },
  enterprise: { label: TIER_META.enterprise.label, description: TIER_DESCRIPTIONS.enterprise, color: TIER_META.enterprise.dotClass, limits: TIER_LIMITS.enterprise },
};

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Colored badge indicating quota health status (OK, Warning, Critical, Unlimited).
 * @param used - Current usage count.
 * @param limit - Quota limit (-1 for unlimited).
 */
function StatusBadge({ used, limit }: { used: number; limit: number }) {
  const { label, color } = statusInfo(used, limit);
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${statusStyles[color]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${barStyles[color]}`} />
      {label}
    </span>
  );
}

/**
 * Card displaying a single quota's usage, progress bar, and optional admin limit editor.
 * @param quotaKey - The quota type (plugins, pipelines, or apiCalls).
 * @param quota - Current quota data including used, limit, and reset info.
 * @param isAdmin - Whether to show the limit editing controls.
 * @param editVal - The current edited limit value.
 * @param onEditChange - Callback when the admin changes the limit.
 */
function QuotaCard({
  quotaKey,
  quota,
  isAdmin,
  editVal,
  onEditChange,
}: {
  quotaKey: QuotaType;
  quota: OrgQuotaResponse['quotas'][QuotaType];
  isAdmin: boolean;
  editVal: number;
  onEditChange: (key: QuotaType, val: number) => void;
}) {
  const meta = QUOTA_META[quotaKey];
  const { color } = statusInfo(quota.used, quota.limit);
  const percentage = quota.unlimited ? 15 : pct(quota.used, quota.limit);
  const isUnlimited = editVal === -1;

  return (
    <div className="card">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{meta.label}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{meta.description}</p>
        </div>
        <StatusBadge used={quota.used} limit={quota.limit} />
      </div>

      <div className="flex items-baseline justify-between mb-2">
        <span className="text-2xl font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
          {fmtNum(quota.used)}
        </span>
        <span className="text-sm text-gray-500 dark:text-gray-400 tabular-nums">
          / {fmtNum(quota.limit)}
        </span>
      </div>

      <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-3">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${barStyles[color]}`}
          style={{ width: `${percentage}%` }}
        />
      </div>

      <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>{quota.unlimited ? 'No limit' : `${fmtNum(quota.remaining)} remaining`}</span>
        <span>Resets {daysUntil(quota.resetAt)}</span>
      </div>

      {!quota.unlimited && <UsageForecast used={quota.used} limit={quota.limit} resetAt={quota.resetAt} />}

      {isAdmin && (
        <div className="flex items-center gap-2 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">Limit</span>
          <input
            type="number"
            min={0}
            value={isUnlimited ? '' : editVal}
            placeholder={isUnlimited ? '\u221E' : ''}
            disabled={isUnlimited}
            className="input w-24 !py-1.5 tabular-nums"
            onChange={(e) => {
              const v = e.target.value === '' ? 0 : parseInt(e.target.value, 10);
              if (!isNaN(v)) onEditChange(quotaKey, Math.max(0, v));
            }}
          />
          <button
            type="button"
            onClick={() => onEditChange(quotaKey, isUnlimited ? (quota.limit === -1 ? 100 : quota.limit) : -1)}
            className={`text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-colors ${
              isUnlimited
                ? 'border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
                : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            &infin; Unlimited
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Sidebar list item for an organization, with a health-color indicator dot.
 * @param org - Organization identity (id, name, slug).
 * @param selected - Whether this org is currently selected.
 * @param healthColor - Tailwind background class for the health indicator dot.
 * @param onClick - Callback when the item is clicked.
 */
function OrgListItem({
  org,
  selected,
  healthColor,
  onClick,
}: {
  org: { id: string; name: string; slug?: string };
  selected: boolean;
  healthColor?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-3 w-full text-left px-4 py-3 border-l-2 transition-colors ${
        selected
          ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-500'
          : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
      }`}
    >
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${healthColor || 'bg-gray-300 dark:bg-gray-600'}`} />
      <div className="min-w-0 flex-1">
        <div className={`text-sm truncate ${selected ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-400'}`}>
          {org.name}
        </div>
        {org.slug && <div className="text-xs text-gray-400 dark:text-gray-500 font-mono truncate">{org.slug}</div>}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

/** Quota management page. Shows per-org usage and limits; system admins can edit tiers, limits, and org metadata. */
export default function QuotasPage() {
  const { user, isReady, isSuperAdmin } = useAuthGuard();
  const toast = useToast();

  const [platformOrgs, setPlatformOrgs] = useState<{ id: string; name: string; slug?: string }[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [orgHealthColors, setOrgHealthColors] = useState<Record<string, string>>({});

  const [orgData, setOrgData] = useState<OrgQuotaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [editValues, setEditValues] = useState({ plugins: 0, pipelines: 0, apiCalls: 0, aiCalls: 0 });
  const [editTier, setEditTier] = useState<QuotaTier>('developer');
  const [dirty, setDirty] = useState(false);

  // System-admin only: orgs at >= 80% on any quota dimension. Refetched
  // alongside the org list so the banner updates after edits.
  const [atRisk, setAtRisk] = useState<Array<{
    orgId: string;
    name: string;
    type: QuotaType;
    used: number;
    limit: number;
    percent: number;
  }>>([]);
  const fetchAtRisk = useCallback(async () => {
    if (!isSuperAdmin) return;
    try {
      const res = await api.getAtRiskQuotas();
      if (res.success && res.data) setAtRisk(res.data.atRisk);
    } catch { /* admin-only diagnostic — silently skip */ }
  }, [isSuperAdmin]);

  const fetchAllOrgs = useCallback(async () => {
    if (!isSuperAdmin) return;
    try {
      const res = await api.listOrganizations();
      const raw = res.data?.organizations || [];
      const orgs = raw.map((o) => ({ id: o.id, name: o.name, slug: o.slug }));
      setPlatformOrgs(orgs);
      if (orgs.length > 0 && !selectedOrgId) setSelectedOrgId(orgs[0].id);
    } catch {
      try {
        const res = await api.getAllOrgQuotas();
        const quotaOrgs = (res.data?.organizations || []) as OrgQuotaResponse[];
        setPlatformOrgs(quotaOrgs.map((o) => ({ id: o.orgId, name: o.name, slug: o.slug })));
        if (quotaOrgs.length > 0 && !selectedOrgId) setSelectedOrgId(quotaOrgs[0].orgId);
      } catch {
        // Both unavailable
      }
    }
  }, [isSuperAdmin, selectedOrgId]);

  const fetchOrg = useCallback(async (orgId: string) => {
    setLoading(true);
    try {
      const res = isSuperAdmin
        ? await api.getOrgQuotas(orgId)
        : await api.getOwnQuotas();
      const quota = (res.data?.quota || res.data) as OrgQuotaResponse;
      // Resolve sidebar metadata at fetch time so applyOrgData doesn't read
      // platformOrgs from its closure. Avoids re-creating fetchOrg every time
      // platformOrgs updates (which would loop through the selectedOrgId effect).
      const sidebarOrg = platformOrgs.find((o) => o.id === (orgId || quota.orgId));
      applyOrgData(quota, { orgId, sidebarName: sidebarOrg?.name, sidebarSlug: sidebarOrg?.slug });
    } catch {
      // API unavailable
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin, platformOrgs]);

  function applyOrgData(
    d: OrgQuotaResponse,
    opts?: { orgId?: string; sidebarName?: string; sidebarSlug?: string },
  ) {
    const name = d.name || opts?.sidebarName || user?.organizationName || d.orgId;
    const slug = d.slug || opts?.sidebarSlug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || d.orgId;
    const resolved: OrgQuotaResponse = { ...d, name, slug };
    setOrgData(resolved);
    setEditValues({
      plugins: resolved.quotas.plugins.limit,
      pipelines: resolved.quotas.pipelines.limit,
      apiCalls: resolved.quotas.apiCalls.limit,
      aiCalls: resolved.quotas.aiCalls.limit,
    });
    setEditTier(resolved.tier || 'developer');
    setDirty(false);
    setOrgHealthColors((prev) => ({ ...prev, [resolved.orgId]: overallHealthColor(resolved.quotas) }));
  }

  useEffect(() => {
    if (isSuperAdmin) {
      fetchAllOrgs();
      fetchAtRisk();
    }
  }, [fetchAllOrgs, fetchAtRisk, isSuperAdmin]);

  useEffect(() => {
    const orgId = isSuperAdmin ? selectedOrgId : user?.organizationId;
    if (orgId) fetchOrg(orgId);
  }, [selectedOrgId, isSuperAdmin, user?.organizationId, fetchOrg]);

  function handleEditChange(key: QuotaType, value: number) {
    setEditValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function handleTierChange(tier: QuotaTier) {
    setEditTier(tier);
    setEditValues({ ...TIER_PRESETS[tier].limits });
    setDirty(true);
  }

  function handleReset() {
    if (orgData) applyOrgData(orgData);
  }

  function handleSelectOrg(orgId: string) {
    if (dirty && !confirm('You have unsaved changes. Discard?')) return;
    setSelectedOrgId(orgId);
  }

  async function handleSave() {
    if (!orgData || !dirty) return;
    setSaving(true);

    const body: Record<string, unknown> = {};
    if (editTier !== (orgData.tier || 'developer')) body.tier = editTier;

    const qc: Record<string, number> = {};
    for (const k of QUOTA_KEYS) {
      if (editValues[k] !== orgData.quotas[k].limit) qc[k] = editValues[k];
    }
    if (Object.keys(qc).length > 0) body.quotas = qc;
    if (Object.keys(body).length === 0) {
      setSaving(false);
      setDirty(false);
      return;
    }

    try {
      const res = await api.updateOrgQuotas(orgData.orgId, body as { name?: string; slug?: string; quotas?: Record<string, number> });
      const updated = (res.data?.quota || res.data) as OrgQuotaResponse;
      applyOrgData(updated);

      toast.success('Saved');
    } catch (error) {
      toast.error(formatError(error, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  }

  const filteredOrgs = platformOrgs.filter((o) => {
    if (!searchFilter) return true;
    const q = searchFilter.toLowerCase();
    return o.name.toLowerCase().includes(q) || (o.slug || '').toLowerCase().includes(q) || o.id.toLowerCase().includes(q);
  });

  if (!isReady || !user) return <LoadingPage />;

  // ── Simple read-only view for regular users ──
  if (!isSuperAdmin) {
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
                : 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${tierPreset.color}`} />
            {tierPreset.label}
          </span>
        ) : undefined}
      >
        <div className="page-section max-w-4xl">
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
            Contact a system administrator to change quota limits.
          </p>
        </div>
      </DashboardLayout>
    );
  }

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
            : 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300'
      }`}>
        <span className={`w-1.5 h-1.5 rounded-full ${TIER_PRESETS[editTier].color}`} />
        {TIER_PRESETS[editTier].label}
      </span>
    </div>
  ) : undefined;

  const headerActions = isSuperAdmin && !loading ? (
    <div className="flex items-center gap-2">
      <button type="button" onClick={handleReset} disabled={!dirty} className="btn btn-secondary btn-xs">
        Discard
      </button>
      <button type="button" onClick={handleSave} disabled={!dirty || saving} className="btn btn-primary btn-xs">
        {saving ? <><LoadingSpinner size="sm" className="mr-2" /> Saving...</> : 'Save'}
      </button>
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
              <input
                type="text"
                placeholder="Filter..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="input !py-1.5 text-xs"
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

/**
 * Projects whether the org will exhaust a quota before its period reset.
 *
 * Assumptions:
 *   - The reset window is monthly (api/ai calls) or per-billing-period.
 *     We approximate the period start as 30 days before `resetAt`; for
 *     monthly windows this matches; for shorter/longer windows it's a
 *     rough estimate that errs toward conservatism (slightly
 *     under-projects the breach date for short windows, slightly over
 *     for long ones).
 *   - Burn rate is linear: a constant per-day usage based on what's
 *     consumed so far this period. Real workloads spike, but a linear
 *     baseline still catches "you're pacing 3× ahead of plan" cases.
 *
 * Renders nothing when used is 0 (no signal to project from) or when
 * the projected total is comfortably under the limit.
 */
function UsageForecast({
  used,
  limit,
  resetAt,
}: {
  used: number;
  limit: number;
  resetAt: string;
}) {
  const reset = new Date(resetAt);
  if (Number.isNaN(reset.getTime()) || limit <= 0 || used <= 0) return null;

  const now = Date.now();
  const periodStart = reset.getTime() - 30 * 24 * 60 * 60 * 1000;
  const elapsed = now - periodStart;
  if (elapsed <= 0) return null;

  const total = reset.getTime() - periodStart;
  const projected = Math.round(used * (total / elapsed));
  const ratio = projected / limit;

  // Only surface the row when it's actually informative — projected ≥
  // 70% of limit (the user is in the warning band).
  if (ratio < 0.7) return null;

  const willBreach = projected > limit;
  const verb = willBreach ? 'will breach' : 'on track for';

  return (
    <div className={`mt-2 px-2 py-1.5 rounded-md text-xs ${willBreach
      ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
      : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300'}`}
    >
      At current pace, {verb} <strong className="tabular-nums">{projected.toLocaleString()}</strong> by reset
      {' '}<span className="opacity-75">(limit {limit.toLocaleString()})</span>.
    </div>
  );
}
