import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, Sun, Moon } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useDarkMode } from '@/hooks/useDarkMode';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { Toast } from '@/components/ui/Toast';
import { pct, fmtNum, daysUntil, statusInfo, statusStyles, barStyles, overallHealthColor } from '@/lib/quota-helpers';
import type { OrgQuotaResponse, QuotaType, QuotaTier } from '@/types';
import api from '@/lib/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUOTA_KEYS: QuotaType[] = ['plugins', 'pipelines', 'apiCalls'];

const QUOTA_META: Record<QuotaType, { label: string; description: string }> = {
  plugins: { label: 'Plugins', description: 'Container images deployed' },
  pipelines: { label: 'Pipelines', description: 'Pipeline configurations' },
  apiCalls: { label: 'API Calls', description: 'Requests this period' },
};

const TIER_KEYS: QuotaTier[] = ['developer', 'pro', 'unlimited'];

const TIER_PRESETS: Record<QuotaTier, { label: string; description: string; color: string; limits: Record<QuotaType, number> }> = {
  developer: { label: 'Developer', description: 'Starter tier', color: 'bg-green-500', limits: { pipelines: 10, plugins: 100, apiCalls: -1 } },
  pro:       { label: 'Pro',       description: 'Production use', color: 'bg-blue-500', limits: { pipelines: 100, plugins: 1000, apiCalls: -1 } },
  unlimited: { label: 'Unlimited', description: 'No restrictions', color: 'bg-purple-500', limits: { pipelines: -1, plugins: -1, apiCalls: -1 } },
};

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function StatusBadge({ used, limit }: { used: number; limit: number }) {
  const { label, color } = statusInfo(used, limit);
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${statusStyles[color]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${barStyles[color]}`} />
      {label}
    </span>
  );
}

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

export default function QuotasPage() {
  const { user, isReady, isSysAdmin } = useAuthGuard();
  const { isDark, toggle } = useDarkMode();

  const [platformOrgs, setPlatformOrgs] = useState<{ id: string; name: string; slug?: string }[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [orgHealthColors, setOrgHealthColors] = useState<Record<string, string>>({});

  const [orgData, setOrgData] = useState<OrgQuotaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const [editValues, setEditValues] = useState({ plugins: 0, pipelines: 0, apiCalls: 0 });
  const [editName, setEditName] = useState('');
  const [editSlug, setEditSlug] = useState('');
  const [editTier, setEditTier] = useState<QuotaTier>('developer');
  const [dirty, setDirty] = useState(false);

  const fetchAllOrgs = useCallback(async () => {
    if (!isSysAdmin) return;
    try {
      const res = await api.listOrganizations();
      const raw = res.organizations || res.data?.organizations || [];
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
  }, [isSysAdmin, selectedOrgId]);

  const fetchOrg = useCallback(async (orgId: string) => {
    setLoading(true);
    try {
      const res = isSysAdmin
        ? await api.getOrgQuotas(orgId)
        : await api.getOwnQuotas();
      const quota = (res.data?.quota || res.data) as OrgQuotaResponse;
      applyOrgData(quota, orgId);
    } catch {
      // API unavailable
    } finally {
      setLoading(false);
    }
  }, [isSysAdmin, platformOrgs]);

  function applyOrgData(d: OrgQuotaResponse, orgId?: string) {
    const sidebarOrg = platformOrgs.find((o) => o.id === (orgId || d.orgId));
    const name = d.name || sidebarOrg?.name || user?.organizationName || d.orgId;
    const slug = d.slug || sidebarOrg?.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || d.orgId;
    const resolved: OrgQuotaResponse = { ...d, name, slug };
    setOrgData(resolved);
    setEditValues({
      plugins: resolved.quotas.plugins.limit,
      pipelines: resolved.quotas.pipelines.limit,
      apiCalls: resolved.quotas.apiCalls.limit,
    });
    setEditName(resolved.name);
    setEditSlug(resolved.slug);
    setEditTier(resolved.tier || 'developer');
    setDirty(false);
    setOrgHealthColors((prev) => ({ ...prev, [resolved.orgId]: overallHealthColor(resolved.quotas) }));
  }

  useEffect(() => {
    if (isSysAdmin) fetchAllOrgs();
  }, [fetchAllOrgs, isSysAdmin]);

  useEffect(() => {
    const orgId = isSysAdmin ? selectedOrgId : user?.organizationId;
    if (orgId) fetchOrg(orgId);
  }, [selectedOrgId, isSysAdmin, user?.organizationId, fetchOrg]);

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
    if (editName !== orgData.name) body.name = editName;
    if (editSlug !== orgData.slug) body.slug = editSlug;
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

      if (body.name || body.slug) {
        setPlatformOrgs((prev) =>
          prev.map((o) => (o.id === updated.orgId ? { ...o, name: updated.name, slug: updated.slug } : o)),
        );
      }
      setToast({ message: 'Saved', type: 'success' });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Failed to save', type: 'error' });
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

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex transition-colors">
      {/* Sidebar */}
      {isSysAdmin && (
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

      {/* Main panel */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm shadow dark:shadow-gray-900/30 border-b border-gray-200/60 dark:border-gray-700/60">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
            <div className="flex items-center space-x-4">
              <Link href="/dashboard" className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors">
                <ArrowLeft className="w-5 h-5" />
              </Link>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                {isSysAdmin ? 'Organization Quotas' : 'Quotas'}
              </h1>
            </div>
            <div className="flex items-center gap-3">
              {isSysAdmin && (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300">
                  System Admin
                </span>
              )}
              {!loading && orgData && (
                <>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300 font-mono">
                    {orgData.orgId}
                  </span>
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    editTier === 'unlimited'
                      ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-300'
                      : editTier === 'pro'
                        ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300'
                        : 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${TIER_PRESETS[editTier].color}`} />
                    {TIER_PRESETS[editTier].label}
                  </span>
                </>
              )}
              <button
                onClick={toggle}
                className="p-2 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                aria-label="Toggle dark mode"
              >
                {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          <div className="max-w-4xl">
            {!loading && orgData && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                {orgData.name} &middot; <span className="font-mono">{orgData.slug}</span>
              </p>
            )}

            {!loading && orgData && isSysAdmin && (
              <div className="mb-8">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-3">
                  Organization
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="label">Name</label>
                    <input
                      type="text"
                      className="input"
                      value={editName}
                      onChange={(e) => { setEditName(e.target.value); setDirty(true); }}
                    />
                  </div>
                  <div>
                    <label className="label">Slug</label>
                    <input
                      type="text"
                      className="input font-mono"
                      value={editSlug}
                      onChange={(e) => { setEditSlug(e.target.value); setDirty(true); }}
                    />
                  </div>
                  <div>
                    <label className="label">Org ID</label>
                    <p className="text-sm text-gray-900 dark:text-gray-100 font-mono pt-2">{orgData.orgId}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Tier selector */}
            {!loading && orgData && (
              <div className="mb-8">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-3">
                  Plan Tier
                </h2>
                <div className="grid grid-cols-3 gap-3">
                  {TIER_KEYS.map((tier) => {
                    const preset = TIER_PRESETS[tier];
                    const isSelected = editTier === tier;
                    return (
                      <button
                        key={tier}
                        type="button"
                        disabled={!isSysAdmin}
                        onClick={() => isSysAdmin && handleTierChange(tier)}
                        className={`relative card text-left transition-all ${
                          isSelected
                            ? 'ring-2 ring-blue-500 dark:ring-blue-400 border-blue-300 dark:border-blue-600'
                            : isSysAdmin
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
                {isSysAdmin && (
                  <span className="font-normal normal-case tracking-normal ml-2 text-gray-400 dark:text-gray-500">
                    — edit limits below each card
                  </span>
                )}
              </h2>

              {loading ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="card">
                      <div className="h-4 skeleton w-1/2 mb-4" />
                      <div className="h-8 skeleton w-1/3 mb-3" />
                      <div className="h-1.5 skeleton rounded-full mb-3" />
                      <div className="h-3 skeleton w-2/3" />
                    </div>
                  ))}
                </div>
              ) : orgData ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {QUOTA_KEYS.map((key) => (
                    <QuotaCard
                      key={key}
                      quotaKey={key}
                      quota={orgData.quotas[key]}
                      isAdmin={isSysAdmin}
                      editVal={editValues[key]}
                      onEditChange={handleEditChange}
                    />
                  ))}
                </div>
              ) : null}
            </div>

            {isSysAdmin && !loading && (
              <div className="flex justify-end gap-3">
                <button type="button" onClick={handleReset} disabled={!dirty} className="btn btn-secondary disabled:opacity-40">
                  Discard
                </button>
                <button type="button" onClick={handleSave} disabled={!dirty || saving} className="btn btn-primary disabled:opacity-40">
                  {saving ? <><LoadingSpinner size="sm" className="mr-2" /> Saving...</> : 'Save Changes'}
                </button>
              </div>
            )}

            {!isSysAdmin && !loading && (
              <p className="text-sm text-gray-400 dark:text-gray-500 text-center mt-6">
                Contact a system administrator to change quota limits.
              </p>
            )}
          </div>
        </main>
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}
