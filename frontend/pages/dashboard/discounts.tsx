import { useMemo, useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { Ticket, Plus, KeyRound, Building2, ShieldAlert, Pencil } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useFormState } from '@/hooks/useFormState';
import { useDelete } from '@/hooks/useDelete';
import { useOrgOptions } from '@/hooks/useOrgOptions';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { SegmentedFilter } from '@/components/ui/SegmentedFilter';
import { Badge } from '@/components/ui/Badge';
import { BillingAdminTabs } from '@/components/billing/BillingAdminTabs';
import { FeatureDisabledCard } from '@/components/ui/FeatureDisabledCard';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { CopyButton } from '@/components/ui/CopyButton';
import { useToast } from '@/components/ui/Toast';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { ApiError } from '@/lib/api/errors';
import api from '@/lib/api';
import { formatCents } from '@/lib/format';
import type { DiscountPriceBreakdown } from '@/lib/api/domains/billing';
import type { Discount } from '@/types';
import { TIER_KEYS } from '@/lib/tiers';

/** Known pricing tiers offered as `appliesToTiers` checkboxes in the edit modal. */
// Selectable tiers a discount can target — sourced from the shared TIER_KEYS so
// the picker never drifts from the tier catalog. (`unlimited` is intentionally absent.)
const TIER_OPTIONS = TIER_KEYS;

/** Human-readable discount amount+kind, e.g. "50% one-time", "$25.00 recurring",
 *  "$100.00 credit". `value` is percent-points for `percent`, else whole CENTS —
 *  so dollar/credit amounts must go through `formatCents`, not raw `$${value}`
 *  (which rendered a $25 discount as "$2500"). */
function formatDiscount(d: Discount): string {
  const amount = d.unit === 'percent' ? `${d.value}%` : formatCents(d.value);
  const kindLabel = d.kind === 'onetime' ? 'one-time' : d.kind;
  return `${amount} ${kindLabel}`;
}

/** Render the itemized discount price breakdown: one row per line item plus the
 *  period total, all money in cents formatted with `formatCents`. */
function PriceBreakdown({ breakdown }: { breakdown: DiscountPriceBreakdown }) {
  if (!breakdown?.items?.length) return null;
  return (
    <dl className="mt-2 space-y-1">
      {breakdown.items.map((item, i) => (
        <div key={i} className="flex items-center justify-between gap-3 text-xs">
          <dt className="text-gray-500 dark:text-gray-400">{item.label}</dt>
          <dd className="font-mono text-gray-700 dark:text-gray-300 text-right tabular-nums">{formatCents(item.cents)}</dd>
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 text-xs border-t border-gray-200 dark:border-gray-700 pt-1 mt-1 font-medium">
        <dt className="text-gray-600 dark:text-gray-300">Total ({breakdown.interval})</dt>
        <dd className="font-mono text-gray-900 dark:text-gray-100 text-right tabular-nums">{formatCents(breakdown.totalCents)}</dd>
      </div>
      {breakdown.creditRemainingCents > 0 && (
        <div className="flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
          <dt>Credit remaining</dt>
          <dd className="font-mono text-right tabular-nums">{formatCents(breakdown.creditRemainingCents)}</dd>
        </div>
      )}
    </dl>
  );
}

/**
 * Discounts management page (system admin only). Lists all minted discounts with
 * authoring (mint), token issuance, direct-to-org grant, and revoke. Backend is
 * gated by BILLING_DISCOUNTS_ENABLED — when off, the endpoints 404 and we fall
 * back to a "not enabled" empty state instead of an error banner.
 */
export default function DiscountsPage() {
  const { user, isReady, isAuthenticated, isSuperAdmin } = useAuthGuard({ requireSystemAdmin: true });
  const toast = useToast();
  // Org picker for "Apply to org" — mirrors the Users page rather than a raw
  // org-id text field, so operators pick from names instead of pasting ids.
  const { orgOptions, loadOrgOptions } = useOrgOptions();

  // When the billing-discounts feature is off the admin endpoints return 404.
  // We catch that in the fetcher and render a dedicated empty state rather than
  // surfacing it as a load error the operator can't act on.
  const [notEnabled, setNotEnabled] = useState(false);

  const list = useListPage<Discount>({
    fields: [
      { key: 'active', type: 'select', defaultValue: 'all', primary: true },
    ],
    fetcher: async (params) => {
      const activeParam = String(params.active || 'all');
      try {
        const response = await api.listDiscounts({
          ...(activeParam !== 'all' && { active: activeParam as 'true' | 'false' }),
          offset: Number(params.offset || 0),
          limit: Number(params.limit || 25),
        });
        setNotEnabled(false);
        const data = response.data;
        return {
          items: data?.discounts || [],
          // Fall back so useListPage.total isn't left stale (undefined) on first
          // load, which can suppress the Pagination control — mirrors the 404 branch.
          pagination: data?.pagination ?? { total: 0, offset: 0 },
        };
      } catch (err) {
        // Fail-soft: feature disabled in this deployment.
        if (err instanceof ApiError && err.statusCode === 404) {
          setNotEnabled(true);
          return { items: [], pagination: { total: 0, offset: 0 } };
        }
        throw err;
      }
    },
    enabled: isAuthenticated && isSuperAdmin,
  });

  // ── Create (mint) ──────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [code, setCode] = useState('');
  const [alias, setAlias] = useState('');
  const [targetOrgId, setTargetOrgId] = useState('');
  const [campaign, setCampaign] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [redeemBy, setRedeemBy] = useState('');
  const createForm = useFormState();

  const openCreate = () => {
    setCode('');
    setAlias('');
    setTargetOrgId('');
    setCampaign('');
    setMaxRedemptions('');
    setRedeemBy('');
    createForm.reset();
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    const trimmedCode = code.trim();
    if (!trimmedCode) return;
    const maxR = maxRedemptions.trim() ? Number(maxRedemptions.trim()) : undefined;
    // Schema floor is 1 (blank = unlimited) — match the edit path so a `0` fails
    // up front instead of as a generic server 400.
    if (maxR !== undefined && (!Number.isFinite(maxR) || maxR < 1)) {
      createForm.setError('Max redemptions must be 1 or more (leave blank for unlimited).');
      return;
    }
    const result = await createForm.run(() => api.createDiscount({
      code: trimmedCode,
      ...(alias.trim() && { alias: alias.trim() }),
      ...(targetOrgId.trim() && { targetOrgId: targetOrgId.trim() }),
      ...(campaign.trim() && { campaign: campaign.trim() }),
      ...(maxR !== undefined && { maxRedemptions: maxR }),
      // <input type="date"> yields YYYY-MM-DD; send as an ISO instant.
      ...(redeemBy.trim() && { redeemBy: new Date(redeemBy.trim()).toISOString() }),
    }));
    if (result !== null) {
      setCreateOpen(false);
      list.refresh();
      toast.success('Discount created');
    }
  };

  // ── Issue token ────────────────────────────────────────
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [issuingId, setIssuingId] = useState<string | null>(null);
  const issueToken = useCallback(async (d: Discount) => {
    setIssuingId(d.id);
    try {
      const res = await api.issueDiscountToken(d.id);
      if (!res.success || !res.data?.token) throw new Error(res.message || 'Failed to issue code');
      setIssuedToken(res.data.token);
    } catch (err) {
      list.setError(formatError(err, 'Failed to issue redeemable code'));
    } finally {
      setIssuingId(null);
    }
  }, [list]);

  // ── Apply to org ───────────────────────────────────────
  const [applyDiscount, setApplyDiscount] = useState<Discount | null>(null);
  const [applyOrgId, setApplyOrgId] = useState('');
  const applyForm = useFormState();

  const openApply = (d: Discount) => {
    setApplyOrgId(d.targetOrgId ?? '');
    setApplyPreview(null);
    applyForm.reset();
    setApplyDiscount(d);
    // Populate the org picker. Best-effort — a failure just leaves it empty
    // (any prefilled target org stays selectable via its own fallback option).
    loadOrgOptions();
  };

  // Dry-run the direct grant so the operator sees the effect before it counts as
  // a redemption. Held alongside the apply modal; cleared when the org id changes.
  const [applyPreview, setApplyPreview] = useState<{ applied: string; priceBreakdown: DiscountPriceBreakdown } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const handlePreviewApply = async () => {
    if (!applyDiscount) return;
    const org = applyOrgId.trim();
    if (!org) {
      applyForm.setError('Enter a target organization id.');
      return;
    }
    setPreviewLoading(true);
    applyForm.setError(null);
    try {
      const res = await api.previewDiscountForOrg(applyDiscount.id, org);
      if (res.success && res.data) setApplyPreview(res.data);
    } catch (err) {
      applyForm.setError(formatError(err, 'Failed to preview discount'));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApply = async () => {
    if (!applyDiscount) return;
    const org = applyOrgId.trim();
    if (!org) {
      applyForm.setError('Enter a target organization id.');
      return;
    }
    const result = await applyForm.run(() => api.applyDiscountToOrg(applyDiscount.id, org));
    if (result !== null) {
      setApplyDiscount(null);
      setApplyPreview(null);
      list.refresh();
      toast.success(`Discount applied to ${org}`);
    }
  };

  // ── Edit (isActive / maxRedemptions / redeemBy / appliesToTiers) ──────
  const [editDiscount, setEditDiscount] = useState<Discount | null>(null);
  const [editMaxRedemptions, setEditMaxRedemptions] = useState('');
  const [editRedeemBy, setEditRedeemBy] = useState('');
  const [editTiers, setEditTiers] = useState<string[]>([]);
  const [editActive, setEditActive] = useState(true);
  const editForm = useFormState();

  const openEdit = (d: Discount) => {
    setEditDiscount(d);
    setEditMaxRedemptions(d.maxRedemptions != null ? String(d.maxRedemptions) : '');
    // <input type="date"> wants YYYY-MM-DD; the record carries a full ISO instant.
    setEditRedeemBy(d.redeemBy ? d.redeemBy.slice(0, 10) : '');
    setEditTiers(d.appliesToTiers ?? []);
    setEditActive(d.isActive);
    editForm.reset();
  };

  const toggleEditTier = (tier: string) => {
    setEditTiers((prev) => prev.includes(tier) ? prev.filter((t) => t !== tier) : [...prev, tier]);
  };

  const handleEdit = async () => {
    if (!editDiscount) return;
    const maxR = editMaxRedemptions.trim() ? Number(editMaxRedemptions.trim()) : undefined;
    // The API only accepts a positive cap (schema min 1); a blank field leaves the
    // existing value untouched rather than clearing it.
    if (maxR !== undefined && (!Number.isFinite(maxR) || maxR < 1)) {
      editForm.setError('Max redemptions must be a positive number (leave blank to keep unchanged).');
      return;
    }
    const body: { isActive?: boolean; maxRedemptions?: number; redeemBy?: string; appliesToTiers?: string[] } = {
      isActive: editActive,
      appliesToTiers: editTiers,
    };
    if (maxR !== undefined) body.maxRedemptions = maxR;
    if (editRedeemBy.trim()) body.redeemBy = new Date(editRedeemBy.trim()).toISOString();
    const result = await editForm.run(() => api.updateDiscount(editDiscount.id, body));
    if (result !== null) {
      setEditDiscount(null);
      list.refresh();
      toast.success('Discount updated');
    }
  };

  // ── Revoke (hard delete) ───────────────────────────────
  const del = useDelete<Discount>(
    (d) => api.deleteDiscount(d.id),
    () => {
      list.refresh();
      toast.success('Discount revoked');
    },
    (err) => list.setError(formatError(err, 'Failed to revoke discount')),
  );

  const columns: Column<Discount>[] = useMemo(() => [
    // NOTE: no `sortValue` on these columns. The list is server-paginated and the
    // discounts list endpoint has no sort param, so a client sort would only
    // reorder the current page — misleading. Sort affordance intentionally
    // dropped until the backend supports it.
    {
      id: 'discount',
      header: 'Discount',
      render: (d) => (
        <div>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 flex flex-wrap items-center gap-1.5">
            {formatDiscount(d)}
            {!d.isActive && <Badge color="gray">Inactive</Badge>}
          </div>
          {d.appliesToTiers && d.appliesToTiers.length > 0 && (
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Tiers: {d.appliesToTiers.join(', ')}
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'campaign',
      header: 'Campaign / Alias',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      render: (d) => (
        <div>
          {d.campaign && <div className="text-gray-700 dark:text-gray-300">{d.campaign}</div>}
          {d.alias && <div className="font-mono text-xs">{d.alias}</div>}
          {!d.campaign && !d.alias && <span className="text-gray-400 dark:text-gray-500">—</span>}
        </div>
      ),
    },
    {
      id: 'targetOrg',
      header: 'Target Org',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      render: (d) => (
        d.targetOrgId
          ? <span className="font-mono text-xs">{d.targetOrgId}</span>
          : <span className="text-gray-400 dark:text-gray-500">Any</span>
      ),
    },
    {
      id: 'redemptions',
      header: 'Redemptions',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      render: (d) => (
        <>{d.timesRedeemed}{d.maxRedemptions != null ? ` / ${d.maxRedemptions}` : ''}</>
      ),
    },
    {
      id: 'redeemBy',
      header: 'Redeem By',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      render: (d) => d.redeemBy
        ? <RelativeTime value={d.redeemBy} />
        : <span className="text-gray-400 dark:text-gray-500">No expiry</span>,
    },
    {
      id: 'status',
      header: 'Status',
      render: (d) => (
        d.isActive
          ? <Badge color="green">Active</Badge>
          : <Badge color="gray">Inactive</Badge>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right text-sm font-medium',
      render: (d) => (
        <div className="flex justify-end gap-3">
          <button
            onClick={() => issueToken(d)}
            disabled={issuingId === d.id}
            className="action-link inline-flex items-center gap-1 disabled:opacity-50"
            title="Issue a redeemable code (bearer credential)"
          >
            <KeyRound className="w-3.5 h-3.5" /> Issue code
          </button>
          <button
            onClick={() => openApply(d)}
            className="action-link inline-flex items-center gap-1"
            title="Apply this discount directly to an organization"
          >
            <Building2 className="w-3.5 h-3.5" /> Apply to org
          </button>
          <button
            onClick={() => openEdit(d)}
            className="action-link inline-flex items-center gap-1"
            title="Edit redemption cap, expiry, tiers, or active state"
          >
            <Pencil className="w-3.5 h-3.5" /> Edit
          </button>
          {d.isActive && (
            <button onClick={() => del.open(d)} className="action-link-danger">Revoke</button>
          )}
        </div>
      ),
    },
  ], [issueToken, issuingId, del]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Discounts"
      subtitle="Mint and manage billing discounts"
      titleExtra={<Badge color="red">System Admin</Badge>}
      actions={
        !notEnabled && (
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4 mr-1.5" /> New Discount
          </Button>
        )
      }
    >
      <BillingAdminTabs active="discounts" />
      <ErrorAlert message={list.error} onDismiss={() => list.setError(null)} />

      {notEnabled ? (
        <FeatureDisabledCard icon={ShieldAlert} title="Discounts are not enabled">
          Discounts are not enabled in this deployment. Set <code className="font-mono">BILLING_DISCOUNTS_ENABLED</code> to
          manage discounts here.
        </FeatureDisabledCard>
      ) : (
        <>
          <div className="filter-bar flex flex-wrap items-center gap-2">
            <SegmentedFilter
              ariaLabel="Filter by active state"
              options={[{ value: 'all', label: 'All' }, { value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]}
              value={String(list.filters.active)}
              onChange={(v) => list.updateFilter('active', v)}
            />
          </div>

          <DataTable
            data={list.data}
            columns={columns}
            isLoading={list.isLoading}
            emptyState={{ icon: Ticket, title: 'No discounts', description: 'No discounts have been minted yet.' }}
            getRowKey={(d) => d.id}
          />

          {!list.isLoading && list.pagination.total > 0 && (
            <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
          )}
        </>
      )}

      {/* Create / mint */}
      {createOpen && (
        <Modal
          title="Mint Discount"
          onClose={() => setCreateOpen(false)}
          footer={
            <ModalFooter
              onCancel={() => setCreateOpen(false)}
              onConfirm={handleCreate}
              confirmLabel="Create Discount"
              loading={createForm.loading}
              confirmDisabled={!code.trim()}
            />
          }
        >
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Code</label>
              <Input
                type="text"
                placeholder="50:percent:onetime"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                className="text-sm font-mono"
                autoFocus
                disabled={createForm.loading}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Format <code className="font-mono">value:unit:kind[:campaign]</code> — unit is
                {' '}<code className="font-mono">percent</code> or <code className="font-mono">dollar</code>; kind is
                {' '}<code className="font-mono">onetime</code>, <code className="font-mono">recurring</code>, or <code className="font-mono">credit</code>.
                {' '}e.g. <code className="font-mono">50:percent:onetime</code>, <code className="font-mono">25:dollar:recurring</code>, <code className="font-mono">100:dollar:credit</code>.
              </p>
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Alias <span className="text-gray-400">(optional)</span></label>
              <Input
                type="text"
                placeholder="e.g. LAUNCH50"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                className="text-sm"
                disabled={createForm.loading}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Target org id <span className="text-gray-400">(optional)</span></label>
              <Input
                type="text"
                placeholder="Leave blank for any org"
                value={targetOrgId}
                onChange={(e) => setTargetOrgId(e.target.value)}
                className="text-sm font-mono"
                disabled={createForm.loading}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Campaign <span className="text-gray-400">(optional)</span></label>
              <Input
                type="text"
                placeholder="e.g. summer-2026"
                value={campaign}
                onChange={(e) => setCampaign(e.target.value)}
                className="text-sm"
                disabled={createForm.loading}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Max redemptions <span className="text-gray-400">(optional)</span></label>
                <Input
                  type="number"
                  min={1}
                  placeholder="Unlimited"
                  value={maxRedemptions}
                  onChange={(e) => setMaxRedemptions(e.target.value)}
                  className="text-sm"
                  disabled={createForm.loading}
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Redeem by <span className="text-gray-400">(optional)</span></label>
                <Input
                  type="date"
                  value={redeemBy}
                  onChange={(e) => setRedeemBy(e.target.value)}
                  className="text-sm"
                  disabled={createForm.loading}
                />
              </div>
            </div>
          </div>
          {createForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{createForm.error}</p>}
        </Modal>
      )}

      {/* Issued token */}
      {issuedToken && (
        <Modal
          title="Redeemable Code"
          onClose={() => setIssuedToken(null)}
          footer={
            <div className="flex items-center justify-end">
              <Button variant="secondary" onClick={() => setIssuedToken(null)}>Done</Button>
            </div>
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
            This opaque code redeems the discount. It is a <strong className="text-gray-700 dark:text-gray-300">bearer credential</strong> —
            anyone who has it can redeem it, so share it carefully. It is shown once here.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 break-all rounded-md bg-gray-100 dark:bg-gray-800 px-3 py-2 text-xs font-mono text-gray-800 dark:text-gray-200">
              {issuedToken}
            </code>
            <CopyButton text={issuedToken} />
          </div>
        </Modal>
      )}

      {/* Apply to org */}
      {applyDiscount && (
        <Modal
          title="Apply Discount to Organization"
          onClose={() => setApplyDiscount(null)}
          footer={
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setApplyDiscount(null)} disabled={applyForm.loading}>Cancel</Button>
              <Button
                variant="secondary"
                onClick={handlePreviewApply}
                loading={previewLoading}
                disabled={!applyOrgId.trim() || applyForm.loading}
              >
                Preview
              </Button>
              <Button
                onClick={handleApply}
                loading={applyForm.loading}
                disabled={!applyOrgId.trim() || previewLoading}
              >
                Apply
              </Button>
            </div>
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Grant <strong className="text-gray-700 dark:text-gray-300">{formatDiscount(applyDiscount)}</strong> directly to an
            organization. Preview the effect first — applying counts as a redemption.
          </p>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Target organization</label>
            <Select
              value={applyOrgId}
              onChange={(e) => { setApplyOrgId(e.target.value); setApplyPreview(null); }}
              className="text-sm"
              aria-label="Target organization"
              autoFocus
              disabled={applyForm.loading}
            >
              <option value="">Select an organization…</option>
              {/* Keep a prefilled target org selectable even if it isn't in the
                  first page of loaded options. */}
              {applyDiscount.targetOrgId && !orgOptions.some((o) => o.id === applyDiscount.targetOrgId) && (
                <option value={applyDiscount.targetOrgId}>{applyDiscount.targetOrgId}</option>
              )}
              {orgOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </Select>
          </div>
          {applyPreview && (
            <div className="mt-4 rounded-md border border-blue-200/70 dark:border-blue-800/60 bg-blue-50/70 dark:bg-blue-900/20 p-3">
              <div className="text-xs font-semibold text-blue-800 dark:text-blue-300">Preview (not applied)</div>
              <div className="mt-1 text-sm text-gray-700 dark:text-gray-300">{applyPreview.applied}</div>
              <PriceBreakdown breakdown={applyPreview.priceBreakdown} />
            </div>
          )}
          {applyForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{applyForm.error}</p>}
        </Modal>
      )}

      {/* Edit */}
      {editDiscount && (
        <Modal
          title="Edit Discount"
          onClose={() => setEditDiscount(null)}
          footer={
            <ModalFooter
              onCancel={() => setEditDiscount(null)}
              onConfirm={handleEdit}
              confirmLabel="Save Changes"
              loading={editForm.loading}
            />
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Editing <strong className="text-gray-700 dark:text-gray-300">{editDiscount.alias || formatDiscount(editDiscount)}</strong>.
            The discount amount and kind are fixed at mint time and can’t be changed here.
          </p>
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <Checkbox
                checked={editActive}
                onChange={(e) => setEditActive(e.target.checked)}
                disabled={editForm.loading}
              />
              <span><strong>Active</strong> — uncheck to deactivate (existing grants persist).</span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Max redemptions</label>
                <Input
                  type="number"
                  min={1}
                  placeholder="Keep unchanged"
                  value={editMaxRedemptions}
                  onChange={(e) => setEditMaxRedemptions(e.target.value)}
                  className="text-sm"
                  disabled={editForm.loading}
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Redeem by</label>
                <Input
                  type="date"
                  value={editRedeemBy}
                  onChange={(e) => setEditRedeemBy(e.target.value)}
                  className="text-sm"
                  disabled={editForm.loading}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Applies to tiers <span className="text-gray-400">(none = all tiers)</span></label>
              <div className="flex flex-wrap gap-2">
                {TIER_OPTIONS.map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    onClick={() => toggleEditTier(tier)}
                    aria-pressed={editTiers.includes(tier)}
                    disabled={editForm.loading}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border capitalize transition-colors ${editTiers.includes(tier)
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                  >
                    {tier}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {editForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{editForm.error}</p>}
        </Modal>
      )}

      {/* Revoke */}
      {del.target && (
        <DeleteConfirmModal
          title="Revoke Discount"
          itemName={del.target.alias || formatDiscount(del.target)}
          loading={del.loading}
          onConfirm={del.confirm}
          onCancel={del.close}
        />
      )}
    </DashboardLayout>
  );
}
