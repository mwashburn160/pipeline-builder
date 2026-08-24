import { useEffect, useState, useCallback, useRef } from 'react';
import { formatError } from '@/lib/constants';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useAuth } from '@/hooks/useAuth';
import { LoadingPage } from '@/components/ui/Loading';
import { useToast } from '@/components/ui/Toast';
import { overallHealthColor } from '@/lib/quota-helpers';
import type { OrgQuotaResponse, QuotaType, QuotaTier, DisplayedQuotaType } from '@/types';
import { QUOTA_KEYS, TIER_PRESETS, buildTierPresets } from '@/components/quotas/constants';
import { QuotasReadOnly, type AtRiskDimension } from '@/components/quotas/QuotasReadOnly';
import { QuotasAdmin } from '@/components/quotas/QuotasAdmin';
import api from '@/lib/api';

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

/** Quota management page. Shows per-org usage and limits; system admins can edit tiers, limits, and org metadata. */
export default function QuotasPage() {
  // Viewing quotas requires `quotas:read` (superadmins bypass). Members hold it
  // in their base bundle. Mutation controls below stay sysadmin-only.
  const { user, isReady, isSuperAdmin, isAdmin, can } = useAuthGuard({ requirePermission: 'quotas:read' });
  const { organizations } = useAuth();
  const toast = useToast();

  // A team (child org) draws from its ROOT's pooled quota: the quota service
  // already reports the root's shared limit + the whole subtree's usage here,
  // so the numbers are correct — we just label them as pooled and read-only.
  const activeOrgIsTeam = !!organizations.find((o) => o.id === user?.organizationId)?.parentOrgId;
  // Can this viewer act on billing? (owner/admin role, or a custom group granted
  // `billing:manage`.) Drives the "Upgrade your plan" link in the read-only view;
  // a team manages billing at its parent, so the link is suppressed there.
  const canManageBilling = (isAdmin || can('billing:manage')) && !activeOrgIsTeam;

  const [platformOrgs, setPlatformOrgs] = useState<{ id: string; name: string; slug?: string }[]>([]);
  // Total org count reported by the server (may exceed the page we hold). Drives
  // the "showing X of Y — refine" hint so a sysadmin knows the picker is capped
  // and that typing in the filter re-queries the server for the rest.
  const [orgTotal, setOrgTotal] = useState(0);
  // Mirror of `platformOrgs` for reads inside `fetchOrg` — keeps that callback
  // from depending on `platformOrgs`, which would re-create it every time the
  // org list loads and re-run the selected-org fetch (a redundant double fetch).
  const platformOrgsRef = useRef(platformOrgs);
  useEffect(() => { platformOrgsRef.current = platformOrgs; }, [platformOrgs]);
  // Request-generation guard for fetchOrg: rapidly selecting org A then B fires
  // overlapping fetches, and whichever RESOLVES last would otherwise win —
  // showing (and letting a sysadmin edit) the wrong org's quotas. Only the
  // latest invocation is allowed to apply data / clear `loading`.
  const orgReqIdRef = useRef(0);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [orgHealthColors, setOrgHealthColors] = useState<Record<string, string>>({});

  const [orgData, setOrgData] = useState<OrgQuotaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [editValues, setEditValues] = useState({ plugins: 0, pipelines: 0, apiCalls: 0, aiCalls: 0 });
  const [editTier, setEditTier] = useState<QuotaTier>('developer');
  const [dirty, setDirty] = useState(false);

  // Effective per-tier presets: seeded from the hardcoded fallback, then replaced
  // with the server's env-override-aware values from /config once they load. Keeps
  // the tier-preset prefill honest under `QUOTA_TIER_*` overrides (pkg#9); fetch
  // failure silently keeps the fallback.
  const [tierPresets, setTierPresets] = useState(TIER_PRESETS);
  useEffect(() => {
    let cancelled = false;
    api.getConfig()
      .then((res) => { if (!cancelled && res.success && res.data?.tierPresets) setTierPresets(buildTierPresets(res.data.tierPresets)); })
      .catch(() => { /* fail-soft: keep the hardcoded fallback presets */ });
    return () => { cancelled = true; };
  }, []);

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

  // Org owner/admin (non-sysadmin): their OWN org's at-risk dimensions, via the
  // tenancy-scoped endpoint — powers the "approaching limit" callout in the
  // read-only view so an owner sees what's near cap without sysadmin. Gated on
  // the admin/owner role (members don't get the callout).
  const canViewOwnAtRisk = !isSuperAdmin && isAdmin;
  const [ownAtRisk, setOwnAtRisk] = useState<AtRiskDimension[]>([]);
  const fetchOwnAtRisk = useCallback(async () => {
    if (!canViewOwnAtRisk || !user?.organizationId) return;
    try {
      const res = await api.getOrgAtRisk(user.organizationId);
      if (res.success && res.data) setOwnAtRisk(res.data.atRisk);
    } catch { /* best-effort admin diagnostic — silently skip */ }
  }, [canViewOwnAtRisk, user?.organizationId]);
  useEffect(() => { fetchOwnAtRisk(); }, [fetchOwnAtRisk]);

  const fetchAllOrgs = useCallback(async (search?: string) => {
    if (!isSuperAdmin) return;
    try {
      // Page size is capped (the server default is ~10). We hold one page and
      // surface the total via `orgTotal`; a `search` term re-queries the server
      // so orgs beyond the held page stay reachable by name — not just the ones
      // that happened to land in the first page.
      const q = (search ?? '').trim();
      const res = await api.listOrganizations({ limit: 200, ...(q ? { search: q } : {}) });
      const raw = res.data?.organizations || [];
      const orgs = raw.map((o) => ({ id: o.id, name: o.name, slug: o.slug }));
      setPlatformOrgs(orgs);
      setOrgTotal(res.data?.pagination?.total ?? orgs.length);
      // Seed the default selection with a functional updater so this callback
      // need not depend on `selectedOrgId` — otherwise picking a different org in
      // the sidebar would re-create fetchAllOrgs and refetch the whole org list.
      if (orgs.length > 0) setSelectedOrgId((cur) => cur || orgs[0].id);
    } catch {
      try {
        const res = await api.getAllOrgQuotas();
        const quotaOrgs = (res.data?.organizations || []) as OrgQuotaResponse[];
        const orgs = quotaOrgs.map((o) => ({ id: o.orgId, name: o.name, slug: o.slug }));
        setPlatformOrgs(orgs);
        setOrgTotal(orgs.length);
        if (orgs.length > 0) setSelectedOrgId((cur) => cur || orgs[0].id);
      } catch {
        // Both unavailable
      }
    }
  }, [isSuperAdmin]);

  const fetchOrg = useCallback(async (orgId: string) => {
    const reqId = ++orgReqIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = isSuperAdmin
        ? await api.getOrgQuotas(orgId)
        : await api.getOwnQuotas();
      // Discard a superseded response: a slower fetch for a previously-selected
      // org must not overwrite the org the user has since switched to.
      if (reqId !== orgReqIdRef.current) return;
      const quota = (res.data?.quota || res.data) as OrgQuotaResponse;
      // Resolve sidebar metadata via the REF (not the closure) so this callback
      // does not depend on `platformOrgs` — depending on it re-created fetchOrg
      // when the list loaded and fetched the selected org's quotas twice.
      const sidebarOrg = platformOrgsRef.current.find((o) => o.id === (orgId || quota.orgId));
      applyOrgData(quota, { orgId, sidebarName: sidebarOrg?.name, sidebarSlug: sidebarOrg?.slug });
    } catch {
      if (reqId !== orgReqIdRef.current) return;
      setLoadError('Failed to load quotas. The service may be unavailable.');
    } finally {
      if (reqId === orgReqIdRef.current) setLoading(false);
    }
  }, [isSuperAdmin]);

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
    if (isSuperAdmin) fetchAtRisk();
  }, [fetchAtRisk, isSuperAdmin]);

  // Debounced org fetch: the empty-term run on mount does the initial load; a
  // typed term re-queries the server (300ms debounce) so orgs past the held page
  // are reachable by name instead of silently truncated at the cap.
  useEffect(() => {
    if (!isSuperAdmin) return;
    const delay = searchFilter ? 300 : 0;
    const t = setTimeout(() => { fetchAllOrgs(searchFilter); }, delay);
    return () => clearTimeout(t);
  }, [searchFilter, isSuperAdmin, fetchAllOrgs]);

  useEffect(() => {
    const orgId = isSuperAdmin ? selectedOrgId : user?.organizationId;
    if (orgId) fetchOrg(orgId);
  }, [selectedOrgId, isSuperAdmin, user?.organizationId, fetchOrg]);

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
    if (dirty && !confirm('You have unsaved changes. Discard?')) return;
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
      applyOrgData(updated, { orgId: orgData.orgId, sidebarName: orgData.name, sidebarSlug: orgData.slug });

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
    applyOrgData(updated, { orgId: orgData.orgId, sidebarName: orgData.name, sidebarSlug: orgData.slug });
    toast.success('Usage counters reset');
    fetchAtRisk();
  }

  const filteredOrgs = platformOrgs.filter((o) => {
    if (!searchFilter) return true;
    const q = searchFilter.toLowerCase();
    return o.name.toLowerCase().includes(q) || (o.slug || '').toLowerCase().includes(q) || o.id.toLowerCase().includes(q);
  });

  if (!isReady || !user) return <LoadingPage />;

  // ── Simple read-only view for regular users ──
  if (!isSuperAdmin) {
    return (
      <QuotasReadOnly
        orgData={orgData}
        loading={loading}
        loadError={loadError}
        onRetry={() => { if (user.organizationId) fetchOrg(user.organizationId); }}
        activeOrgIsTeam={activeOrgIsTeam}
        canManageBilling={canManageBilling}
        atRisk={ownAtRisk}
      />
    );
  }

  return (
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
      user={user}
      setSearchFilter={setSearchFilter}
      handleSelectOrg={handleSelectOrg}
      handleReset={handleReset}
      handleSave={handleSave}
      handleEditChange={handleEditChange}
      handleTierChange={handleTierChange}
      fetchOrg={fetchOrg}
      fetchAtRisk={fetchAtRisk}
      onResetUsage={handleResetUsage}
    />
  );
}
