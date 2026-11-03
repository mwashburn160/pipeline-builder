import { useMemo, useState, useCallback } from 'react';
import { Megaphone, Plus, ShieldAlert, Ban } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useListPage } from '@/hooks/useListPage';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { SegmentedFilter } from '@/components/ui/SegmentedFilter';
import { Badge } from '@/components/ui/Badge';
import { BillingAdminTabs } from '@/components/billing/BillingAdminTabs';
import { FeatureDisabledCard } from '@/components/ui/FeatureDisabledCard';
import { CreateCampaignModal } from '@/components/discounts/CreateCampaignModal';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { useToast } from '@/components/ui/Toast';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { ApiError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { Campaign } from '@/types';

/** Cents → `$1,234.56`, so a budget reads as money rather than an integer. */
function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Campaigns page (system admin only) — the identity a set of discount codes and
 * promotions belongs to, with the budget, window and one-per-account rule that
 * cannot be expressed on an individual code.
 *
 * Backend is gated by `BILLING_DISCOUNTS_ENABLED` (a campaign only exists to
 * govern discount codes), so a 404 becomes the "not enabled" state rather than
 * an error banner the operator cannot act on — same as the Discounts page.
 */
export default function CampaignsPage() {
  const { accessDenied, isReady, isAuthenticated, can } = useAuthGuard();
  const toast = useToast();
  const [notEnabled, setNotEnabled] = useState(false);

  const list = useListPage<Campaign>({
    fields: [
      { key: 'active', type: 'select', defaultValue: 'all', primary: true },
    ],
    fetcher: async (params) => {
      const activeParam = String(params.active || 'all');
      try {
        const response = await api.listCampaigns({
          ...(activeParam !== 'all' && { active: activeParam as 'true' | 'false' }),
          offset: Number(params.offset || 0),
          limit: Number(params.limit || 25),
        });
        setNotEnabled(false);
        const data = response.data;
        return {
          items: data?.campaigns || [],
          pagination: data?.pagination ?? { total: 0, offset: 0 },
        };
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 404) {
          setNotEnabled(true);
          return { items: [], pagination: { total: 0, offset: 0 } };
        }
        throw err;
      }
    },
    enabled: isAuthenticated && can('billing:operate'),
  });

  const [createOpen, setCreateOpen] = useState(false);

  // Ending a campaign also deactivates every code in it, which is the point —
  // so it is confirmed, and the confirmation says how many codes it will take.
  const [endTarget, setEndTarget] = useState<Campaign | null>(null);
  const [ending, setEnding] = useState(false);
  const endCampaign = useCallback(async () => {
    if (!endTarget) return;
    setEnding(true);
    try {
      const res = await api.endCampaign(endTarget.id);
      const n = res.data?.discountsDeactivated ?? 0;
      toast.success(n === 1 ? 'Campaign ended, 1 code deactivated' : `Campaign ended, ${n} codes deactivated`);
      setEndTarget(null);
      list.refresh();
    } catch (err) {
      list.setError(formatError(err, 'Could not end the campaign'));
    } finally {
      setEnding(false);
    }
  }, [endTarget, list, toast]);

  const columns = useMemo<Column<Campaign>[]>(() => [
    {
      id: 'name',
      header: 'Campaign',
      render: (c) => (
        <div>
          <div className="font-medium">{c.name}</div>
          <code className="text-xs text-fg-subtle font-mono">{c.id}</code>
        </div>
      ),
    },
    {
      id: 'state',
      header: 'State',
      // `isActive` alone does not say whether a redemption would succeed — a
      // campaign can be active but not yet started, past its end, or out of
      // budget. `open` is the server's single answer, so the badge matches what
      // a redemption would actually do.
      render: (c) => {
        if (!c.isActive) return <Badge color="gray">Ended</Badge>;
        if (c.budgetExhausted) return <Badge color="yellow">Budget spent</Badge>;
        if (c.started === false) return <Badge color="blue">Scheduled</Badge>;
        if (c.ended) return <Badge color="gray">Expired</Badge>;
        return <Badge color="green">Open</Badge>;
      },
    },
    {
      id: 'budget',
      header: 'Budget',
      render: (c) => (
        c.budgetCents == null
          ? <span className="text-fg-subtle">Unlimited</span>
          : (
            <div className="tabular-nums">
              <div>{money(c.spentCents)} <span className="text-fg-subtle">of {money(c.budgetCents)}</span></div>
              <div className="text-xs text-fg-subtle">{money(c.remainingCents ?? 0)} left</div>
            </div>
          )
      ),
    },
    {
      id: 'rules',
      header: 'Rules',
      render: (c) => (
        <div className="flex flex-wrap gap-1">
          {c.exclusive && <Badge color="blue">One per account</Badge>}
          {c.startsAt && <Badge color="gray">From {new Date(c.startsAt).toLocaleDateString()}</Badge>}
          {c.endsAt && <Badge color="gray">Until {new Date(c.endsAt).toLocaleDateString()}</Badge>}
          {!c.exclusive && !c.startsAt && !c.endsAt && <span className="text-fg-subtle">—</span>}
        </div>
      ),
    },
    { id: 'grantsCount', header: 'Redemptions', render: (c) => <span className="tabular-nums">{c.grantsCount}</span> },
    { id: 'createdAt', header: 'Created', render: (c) => (c.createdAt ? <RelativeTime value={c.createdAt} /> : '—') },
    {
      id: 'actions',
      header: '',
      render: (c) => (
        c.isActive
          ? (
            <Button variant="ghost" size="sm" onClick={() => setEndTarget(c)} aria-label={`End campaign ${c.name}`}>
              <Ban className="h-4 w-4" /> End
            </Button>
          )
          : null
      ),
    },
  ], []);

  if (!isReady) return <LoadingPage />;
  if (accessDenied) return <AccessDenied denial={accessDenied} />;

  return (
    <DashboardLayout
      title="Campaigns"
      subtitle="One budget, window and per-account rule across a set of discount codes"
      actions={
        <Button onClick={() => setCreateOpen(true)} disabled={notEnabled}>
          <Plus className="h-4 w-4" /> Create campaign
        </Button>
      }
    >
      <BillingAdminTabs active="campaigns" />
      <ErrorAlert message={list.error} onRetry={list.refresh} onDismiss={() => list.setError(null)} />

      {notEnabled ? (
        <FeatureDisabledCard icon={ShieldAlert} title="Discounts are not enabled">
          Campaigns govern discount codes, so they share the discount surface&apos;s
          flag. Set <code className="font-mono">BILLING_DISCOUNTS_ENABLED</code> to
          manage campaigns here.
        </FeatureDisabledCard>
      ) : (
        <>
          <div className="filter-bar flex flex-wrap items-center gap-2">
            <SegmentedFilter
              ariaLabel="Filter by active state"
              options={[{ value: 'all', label: 'All' }, { value: 'true', label: 'Active' }, { value: 'false', label: 'Ended' }]}
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
            emptyState={{
              icon: Megaphone,
              title: 'No campaigns',
              description: 'Create a campaign to group discount codes under a shared budget, window and one-per-account rule.',
            }}
            getRowKey={(c) => c.id}
          />

          {!list.isLoading && list.pagination.total > 0 && (
            <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
          )}
        </>
      )}

      {createOpen && (
        <CreateCampaignModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            list.refresh();
            toast.success('Campaign created');
          }}
        />
      )}

      {endTarget && (
        <DeleteConfirmModal
          title="End campaign"
          itemName={`${endTarget.name} — this also deactivates every discount code in it`}
          loading={ending}
          onCancel={() => setEndTarget(null)}
          onConfirm={endCampaign}
        />
      )}
    </DashboardLayout>
  );
}
