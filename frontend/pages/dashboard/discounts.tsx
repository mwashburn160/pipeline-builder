import { useMemo, useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { Ticket, Plus, KeyRound, Building2, ShieldAlert, Pencil, Eye } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useListPage } from '@/hooks/useListPage';
import { useDelete } from '@/hooks/useDelete';
import { useOrgOptions } from '@/hooks/useOrgOptions';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { SegmentedFilter } from '@/components/ui/SegmentedFilter';
import { Badge } from '@/components/ui/Badge';
import { BillingAdminTabs } from '@/components/billing/BillingAdminTabs';
import { DiscountDetailDrawer } from '@/components/billing/DiscountDetailDrawer';
import { useDetailParam } from '@/components/billing/useDetailParam';
import { FeatureDisabledCard } from '@/components/ui/FeatureDisabledCard';
import { Modal } from '@/components/ui/Modal';
import { MintDiscountModal } from '@/components/discounts/MintDiscountModal';
import { ApplyDiscountModal } from '@/components/discounts/ApplyDiscountModal';
import { EditDiscountModal } from '@/components/discounts/EditDiscountModal';
import { formatDiscount } from '@/components/discounts/formatDiscount';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { CopyButton } from '@/components/ui/CopyButton';
import { useToast } from '@/components/ui/Toast';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { ApiError } from '@/lib/api/errors';
import api from '@/lib/api';
import type { Discount } from '@/types';

/**
 * Discounts management page (system admin only). Lists all minted discounts with
 * authoring (mint), token issuance, direct-to-org grant, and revoke. Backend is
 * gated by BILLING_DISCOUNTS_ENABLED — when off, the endpoints 404 and we fall
 * back to a "not enabled" empty state instead of an error banner.
 */
export default function DiscountsPage() {
  // System-admin gate comes from page-access.ts (a "Billing Admin" sub-route).
  const { accessDenied, user, isReady, isAuthenticated, isSuperAdmin } = useAuthGuard();
  // Discount open in the detail drawer — `?id=` so it's deep-linkable.
  const [detailId, setDetailId] = useDetailParam();
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
  const openCreate = () => setCreateOpen(true);

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

  const openApply = (d: Discount) => {
    setApplyDiscount(d);
    // Populate the org picker. Best-effort — a failure just leaves it empty
    // (any prefilled target org stays selectable via its own fallback option).
    loadOrgOptions();
  };

  // ── Edit (isActive / maxRedemptions / redeemBy / appliesToTiers) ──────
  const [editDiscount, setEditDiscount] = useState<Discount | null>(null);
  const openEdit = (d: Discount) => setEditDiscount(d);

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
            onClick={() => setDetailId(d.id)}
            className="action-link inline-flex items-center gap-1"
            title="View the full discount record"
          >
            <Eye className="w-3.5 h-3.5" /> Details
          </button>
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
  ], [issueToken, issuingId, del, setDetailId]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
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
      <ErrorAlert message={list.error} onRetry={list.refresh} onDismiss={() => list.setError(null)} />

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
            loadFailed={!!list.error}
            onRetry={list.refresh}
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
        <MintDiscountModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            list.refresh();
            toast.success('Discount created');
          }}
        />
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
        <ApplyDiscountModal
          key={applyDiscount.id}
          discount={applyDiscount}
          orgOptions={orgOptions}
          onClose={() => setApplyDiscount(null)}
          onApplied={(org) => {
            setApplyDiscount(null);
            list.refresh();
            toast.success(`Discount applied to ${org}`);
          }}
        />
      )}

      {/* Edit */}
      {editDiscount && (
        <EditDiscountModal
          key={editDiscount.id}
          discount={editDiscount}
          onClose={() => setEditDiscount(null)}
          onSaved={() => {
            setEditDiscount(null);
            list.refresh();
            toast.success('Discount updated');
          }}
        />
      )}

      {/* Detail (deep-linkable via ?id=) */}
      {detailId && !notEnabled && <DiscountDetailDrawer id={detailId} onClose={() => setDetailId(null)} />}

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
