import { useMemo, useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { Ticket, Plus, KeyRound, Building2, ShieldAlert } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useFormState } from '@/hooks/useFormState';
import { useDelete } from '@/hooks/useDelete';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
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
import type { Discount } from '@/types';

/** Human-readable discount amount+kind, e.g. "50% one-time", "$25 recurring", "$100 credit". */
function formatDiscount(d: Discount): string {
  const amount = d.unit === 'percent' ? `${d.value}%` : `$${d.value}`;
  const kindLabel = d.kind === 'onetime' ? 'one-time' : d.kind;
  return `${amount} ${kindLabel}`;
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
          pagination: data?.pagination,
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
    if (maxR !== undefined && (!Number.isFinite(maxR) || maxR < 0)) {
      createForm.setError('Max redemptions must be a non-negative number.');
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
    applyForm.reset();
    setApplyDiscount(d);
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
      list.refresh();
      toast.success(`Discount applied to ${org}`);
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
    {
      id: 'discount',
      header: 'Discount',
      sortValue: (d) => d.value,
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
      sortValue: (d) => d.campaign ?? d.alias ?? '',
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
      sortValue: (d) => d.targetOrgId ?? '',
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
      sortValue: (d) => d.timesRedeemed,
      render: (d) => (
        <>{d.timesRedeemed}{d.maxRedemptions != null ? ` / ${d.maxRedemptions}` : ''}</>
      ),
    },
    {
      id: 'redeemBy',
      header: 'Redeem By',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (d) => d.redeemBy ? new Date(d.redeemBy) : null,
      render: (d) => d.redeemBy
        ? <RelativeTime value={d.redeemBy} />
        : <span className="text-gray-400 dark:text-gray-500">No expiry</span>,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (d) => (d.isActive ? 1 : 0),
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
      <ErrorAlert message={list.error} onDismiss={() => list.setError(null)} />

      {notEnabled ? (
        <div className="card flex flex-col items-center text-center py-14">
          <div className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-gray-700/50 flex items-center justify-center">
            <ShieldAlert className="w-9 h-9 text-gray-400 dark:text-gray-500" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-gray-900 dark:text-gray-100">Discounts are not enabled</h3>
          <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400 max-w-sm">
            Discounts are not enabled in this deployment. Set <code className="font-mono">BILLING_DISCOUNTS_ENABLED</code> to
            manage discounts here.
          </p>
        </div>
      ) : (
        <>
          <div className="filter-bar flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1" role="group" aria-label="Filter by active state">
              {([['all', 'All'], ['true', 'Active'], ['false', 'Inactive']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => list.updateFilter('active', value)}
                  aria-pressed={String(list.filters.active) === value}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${String(list.filters.active) === value
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <DataTable
            data={list.data}
            columns={columns}
            isLoading={list.isLoading}
            emptyState={{ icon: Ticket, title: 'No discounts', description: 'No discounts have been minted yet.' }}
            getRowKey={(d) => d.id}
            defaultSortColumn="discount"
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
                  min={0}
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
            <ModalFooter
              onCancel={() => setApplyDiscount(null)}
              onConfirm={handleApply}
              confirmLabel="Apply"
              loading={applyForm.loading}
              confirmDisabled={!applyOrgId.trim()}
            />
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Grant <strong className="text-gray-700 dark:text-gray-300">{formatDiscount(applyDiscount)}</strong> directly to an
            organization. This counts as a redemption.
          </p>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Target org id</label>
            <Input
              type="text"
              placeholder="e.g. org_abc123"
              value={applyOrgId}
              onChange={(e) => setApplyOrgId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleApply()}
              className="text-sm font-mono"
              autoFocus
              disabled={applyForm.loading}
            />
          </div>
          {applyForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{applyForm.error}</p>}
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
