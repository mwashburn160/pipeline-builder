import { useEffect, useState, useMemo } from 'react';
import { formatError } from '@/lib/constants';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useDebounce } from '@/hooks/useDebounce';
import { useFetch } from '@/hooks/useFetch';
import { useQuery } from '@/hooks/useQuery';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useOrgHierarchy } from '@/hooks/useOrgHierarchy';
import { useFeatures } from '@/hooks/useFeatures';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingPage } from '@/components/ui/Loading';
import { useToast } from '@/components/ui/Toast';
import { overallHealthColor } from '@/lib/quota-helpers';
import { QUOTA_WARNING_THRESHOLD } from '@/lib/constants';
import type { OrgQuotaResponse, QuotaType, QuotaTier, DisplayedQuotaType } from '@/types';
import { QUOTA_KEYS, buildTierPresets } from '@/components/quotas/constants';
import { QuotasReadOnly, type AtRiskDimension } from '@/components/quotas/QuotasReadOnly';
import { QuotasAdmin } from '@/components/quotas/QuotasAdmin';
import api from '@/lib/api';
import { queries } from '@/lib/api-cache';

/** One org in the sysadmin picker. */
type PickerOrg = { id: string; name: string; slug?: string };

/** Picker page size; a typed filter re-queries the server for the rest. */
const ORG_PICKER_LIMIT = 200;

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

/** Quota management page. Shows per-org usage and limits; system admins can edit tiers, limits, and org metadata. */
export default function QuotasPage() {
  // Viewing quotas requires `quotas:read` (declared once, in page-access.ts via
  // the nav entry; superadmins bypass). Members hold it in their base bundle.
  // Mutation controls below stay sysadmin-only.
  const { accessDenied, user, isReady, isSuperAdmin, isAdmin, can } = useAuthGuard();
  const toast = useToast();

  // A team (child org) draws from its ROOT's pooled quota: the quota service
  // already reports the root's shared limit + the whole subtree's usage here,
  // so the numbers are correct — we just label them as pooled and read-only.
  // A root with teams sees the same pooled figures (its own usage + every team's).
  const { isChildOrg: activeOrgIsTeam, hasChildOrgs: activeOrgHasTeams } = useOrgHierarchy();
  // Can this viewer act on billing? (owner/admin role, or a custom group granted
  // `billing:manage`.) Drives the "Upgrade your plan" link in the read-only view;
  // a team manages billing at its parent, so the link is suppressed there.
  const canManageBilling = (isAdmin || can('billing:manage')) && !activeOrgIsTeam;

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  // Org the admin is switching to while the current one has unsaved edits.
  const [pendingOrgSwitch, setPendingOrgSwitch] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [orgHealthColors, setOrgHealthColors] = useState<Record<string, string>>({});

  const [orgData, setOrgData] = useState<OrgQuotaResponse | null>(null);
  const [saving, setSaving] = useState(false);

  const [editValues, setEditValues] = useState({ plugins: 0, pipelines: 0, apiCalls: 0, aiCalls: 0 });
  const [editTier, setEditTier] = useState<QuotaTier>('developer');
  const [dirty, setDirty] = useState(false);

  // Effective per-tier presets: the hardcoded fallback overlaid with the server's
  // env-override-aware values from /config (already loaded by FeaturesProvider),
  // so the tier-preset prefill stays honest under `QUOTA_TIER_*` overrides (pkg#9).
  const serverTierPresets = useFeatures().tierPresets;
  const tierPresets = useMemo(() => buildTierPresets(serverTierPresets), [serverTierPresets]);

  // The at-risk cut-off, in percent. The API has always taken `threshold` (and
  // the client has always forwarded it); this page pinned it to the server's 80
  // default, so "who has ALREADY run out?" — threshold=100 — was unaskable, and
  // so was widening the early warning. It drives BOTH at-risk reads below, so
  // the sysadmin banner and an owner's own callout agree on what "at risk" is.
  const [atRiskThreshold, setAtRiskThreshold] = useState(QUOTA_WARNING_THRESHOLD);

  // System-admin only: orgs at >= the chosen cut-off on any quota dimension.
  // Re-read after edits and usage resets so the banner stays current. Admin
  // diagnostic — a failure just shows no banner.
  const atRiskQ = useFetch(async () => {
    if (!isSuperAdmin) return [];
    try {
      const res = await api.getAtRiskQuotas(atRiskThreshold);
      return res.success && res.data ? res.data.atRisk : [];
    } catch {
      return [];
    }
  }, [isSuperAdmin, atRiskThreshold]);
  const atRisk = atRiskQ.data ?? [];
  const fetchAtRisk = atRiskQ.refetch;

  // Org owner/admin (non-sysadmin): their OWN org's at-risk dimensions, via the
  // tenancy-scoped endpoint — powers the "approaching limit" callout in the
  // read-only view so an owner sees what's near cap without sysadmin. Gated on
  // the admin/owner role (members don't get the callout). Best-effort.
  const canViewOwnAtRisk = !isSuperAdmin && isAdmin;
  const ownAtRiskQ = useFetch(async (): Promise<AtRiskDimension[]> => {
    if (!canViewOwnAtRisk || !user?.organizationId) return [];
    try {
      const res = await api.getOrgAtRisk(user.organizationId, atRiskThreshold);
      return res.success && res.data ? res.data.atRisk : [];
    } catch {
      return [];
    }
  }, [canViewOwnAtRisk, user?.organizationId, atRiskThreshold]);
  const ownAtRisk = ownAtRiskQ.data ?? [];

  // Sysadmin org picker. Page size is capped; a typed term (debounced) re-queries
  // the server so orgs beyond the held page stay reachable by name. Through the
  // shared cache, so an older term's late answer can't replace a newer one — the
  // query key IS the term. If the org directory is unavailable, fall back to
  // the quota service's own org list.
  const debouncedSearch = useDebounce(searchFilter.trim(), 300);
  const orgsQ = useQuery(isSuperAdmin
    ? queries.listOrganizations({ limit: ORG_PICKER_LIMIT, ...(debouncedSearch ? { search: debouncedSearch } : {}) })
    : null);
  const fallbackQ = useFetch(async (): Promise<PickerOrg[] | null> => {
    if (!isSuperAdmin || !orgsQ.error) return null;
    const res = await api.getAllOrgQuotas();
    return ((res.data?.organizations || []) as OrgQuotaResponse[]).map((o) => ({ id: o.orgId, name: o.name, slug: o.slug }));
  }, [isSuperAdmin, !!orgsQ.error]);
  const platformOrgs: PickerOrg[] = useMemo(() => {
    if (orgsQ.error) return fallbackQ.data ?? [];
    return (orgsQ.data?.data?.organizations ?? []).map((o) => ({ id: o.id, name: o.name, slug: o.slug }));
  }, [orgsQ.data, orgsQ.error, fallbackQ.data]);
  // Total org count reported by the server (may exceed the page we hold). Drives
  // the "showing X of Y — refine" hint so a sysadmin knows the picker is capped.
  const orgTotal = orgsQ.error ? platformOrgs.length : (orgsQ.data?.data?.pagination?.total ?? platformOrgs.length);

  // Seed the default selection once the first page lands.
  useEffect(() => {
    if (platformOrgs.length > 0) setSelectedOrgId((cur) => cur || platformOrgs[0].id);
  }, [platformOrgs]);

  // The selected org's quotas (sysadmin: any org; everyone else: their own).
  // useFetch drops a superseded response, so selecting Alpha then Beta always
  // shows Beta even when Alpha's read resolves last.
  const quotaOrgId = isSuperAdmin ? selectedOrgId : user?.organizationId;
  const orgQ = useFetch(async (): Promise<{ orgId: string; quota: OrgQuotaResponse } | null> => {
    if (!quotaOrgId) return null;
    const res = isSuperAdmin ? await api.getOrgQuotas(quotaOrgId) : await api.getOwnQuotas();
    return { orgId: quotaOrgId, quota: (res.data?.quota || res.data) as OrgQuotaResponse };
  }, [quotaOrgId, isSuperAdmin]);
  const loading = orgQ.loading;
  const loadError = orgQ.error ? 'Failed to load quotas. The service may be unavailable.' : null;
  const retryOrg = orgQ.refetch;

  // A freshly read org seeds the view + the edit form.
  const loadedOrg = orgQ.data;
  useEffect(() => {
    if (!loadedOrg) return;
    const sidebarOrg = platformOrgs.find((o) => o.id === loadedOrg.orgId);
    applyOrgData(loadedOrg.quota, { orgId: loadedOrg.orgId, sidebarName: sidebarOrg?.name, sidebarSlug: sidebarOrg?.slug });
    // Seeds on a NEW read only — a picker-page change must not reset edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seeds on a NEW read only — a picker-page change must not reset edits
  }, [loadedOrg]);

  function applyOrgData(
    d: OrgQuotaResponse,
    opts?: { orgId?: string; sidebarName?: string; sidebarSlug?: string; keepPool?: OrgQuotaResponse['pool'] },
  ) {
    const name = d.name || opts?.sidebarName || user?.organizationName || d.orgId;
    const slug = d.slug || opts?.sidebarSlug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || d.orgId;
    // The quota service's update / reset-usage responses are built straight from
    // the org row (`buildOrgQuotaResponse`) and carry NO `pool` block — only the
    // reads overlay it. Re-applying one verbatim therefore dropped the pooling
    // banner (and the root's name with it) the moment a sysadmin saved or reset.
    const pool = d.pool ?? opts?.keepPool;
    const resolved: OrgQuotaResponse = { ...d, name, slug, ...(pool ? { pool } : {}) };
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

  function handleEditChange(key: DisplayedQuotaType, value: number) {
    setEditValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function handleTierChange(tier: QuotaTier) {
    setEditTier(tier);
    setEditValues({ ...tierPresets[tier].limits });
    setDirty(true);
  }

  function handleReset() {
    if (orgData) applyOrgData(orgData);
  }

  function handleSelectOrg(orgId: string) {
    // Switching orgs throws away unsaved quota edits — ask in-app rather than
    // through the browser's unstyled confirm.
    if (dirty) { setPendingOrgSwitch(orgId); return; }
    setSelectedOrgId(orgId);
  }

  async function handleSave() {
    if (!orgData || !dirty) return;
    setSaving(true);

    const body: { tier?: QuotaTier; quotas?: Record<string, number> } = {};
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
      const res = await api.updateOrgQuotas(orgData.orgId, body);
      const updated = (res.data?.quota || res.data) as OrgQuotaResponse;
      // Pass the sidebar identity (as handleResetUsage does) — if the update
      // response omits `name`, the fallback chain would otherwise resolve to the
      // acting sysadmin's own org name while editing a different org.
      applyOrgData(updated, { orgId: orgData.orgId, sidebarName: orgData.name, sidebarSlug: orgData.slug, keepPool: orgData.pool });

      toast.success('Saved');
    } catch (error) {
      toast.error(formatError(error, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  }

  // Sysadmin operational action: zero the selected org's usage counters
  // mid-period (limits untouched). The confirm + busy state live in QuotasAdmin;
  // this owns the API call, in-place refresh, and at-risk re-fetch. Rejections
  // propagate so the modal can surface them and stay open.
  async function handleResetUsage() {
    if (!orgData) return;
    const res = await api.resetOrgQuota(orgData.orgId);
    const updated = (res.data?.quota || res.data) as OrgQuotaResponse;
    applyOrgData(updated, { orgId: orgData.orgId, sidebarName: orgData.name, sidebarSlug: orgData.slug, keepPool: orgData.pool });
    toast.success('Usage counters reset');
    fetchAtRisk();
  }

  const filteredOrgs = platformOrgs.filter((o) => {
    if (!searchFilter) return true;
    const q = searchFilter.toLowerCase();
    return o.name.toLowerCase().includes(q) || (o.slug || '').toLowerCase().includes(q) || o.id.toLowerCase().includes(q);
  });

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  // ── Simple read-only view for regular users ──
  if (!isSuperAdmin) {
    return (
      <QuotasReadOnly
        orgData={orgData}
        loading={loading}
        loadError={loadError}
        onRetry={retryOrg}
        activeOrgIsTeam={activeOrgIsTeam}
        activeOrgHasTeams={activeOrgHasTeams}
        canManageBilling={canManageBilling}
        atRisk={ownAtRisk}
        atRiskThreshold={atRiskThreshold}
        setAtRiskThreshold={setAtRiskThreshold}
      />
    );
  }

  return (
    <>
    {pendingOrgSwitch && (
      <ConfirmDialog
        title="Discard unsaved quota changes?"
        confirmLabel="Discard and switch"
        cancelLabel="Keep editing"
        tone="danger"
        onCancel={() => setPendingOrgSwitch(null)}
        onConfirm={() => { setSelectedOrgId(pendingOrgSwitch); setPendingOrgSwitch(null); }}
      >
        <p>The quota edits for the current organization haven&apos;t been saved. Switching now loses them.</p>
      </ConfirmDialog>
    )}
    <QuotasAdmin
      isSuperAdmin={isSuperAdmin}
      loading={loading}
      orgData={orgData}
      loadError={loadError}
      editTier={editTier}
      editValues={editValues}
      tierPresets={tierPresets}
      dirty={dirty}
      saving={saving}
      platformOrgs={platformOrgs}
      filteredOrgs={filteredOrgs}
      orgTotal={orgTotal}
      searchFilter={searchFilter}
      selectedOrgId={selectedOrgId}
      orgHealthColors={orgHealthColors}
      atRisk={atRisk}
      atRiskThreshold={atRiskThreshold}
      setAtRiskThreshold={setAtRiskThreshold}
      user={user}
      setSearchFilter={setSearchFilter}
      handleSelectOrg={handleSelectOrg}
      handleReset={handleReset}
      handleSave={handleSave}
      handleEditChange={handleEditChange}
      handleTierChange={handleTierChange}
      onRetryOrg={retryOrg}
      fetchAtRisk={fetchAtRisk}
      onResetUsage={handleResetUsage}
    />
    </>
  );
}
