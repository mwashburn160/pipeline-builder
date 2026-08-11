// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState, useEffect, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { CreditCard, Pencil, DatabaseZap, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useFormState } from '@/hooks/useFormState';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { BillingAdminTabs } from '@/components/billing/BillingAdminTabs';
import { Modal } from '@/components/ui/Modal';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { useToast } from '@/components/ui/Toast';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { formatCents } from '@/lib/format';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import type { AdminBillingSummary, AdminSubscriptionUpdate } from '@/lib/api/domains/billing';
import type { Plan, Subscription, SubscriptionStatus, BillingInterval } from '@/types';

/** Editable subscription statuses (mirrors AdminSubscriptionUpdateSchema — note the
 *  provider-only `unpaid` is intentionally excluded, it isn't admin-settable). */
const STATUS_OPTIONS = ['active', 'canceled', 'past_due', 'trialing', 'incomplete'] as const;
type EditableStatus = typeof STATUS_OPTIONS[number];
const INTERVAL_OPTIONS: BillingInterval[] = ['monthly', 'annual'];

/** Badge color per subscription status. */
function statusColor(status: string): 'green' | 'gray' | 'yellow' | 'red' | 'blue' {
  switch (status) {
    case 'active': return 'green';
    case 'trialing': return 'blue';
    case 'past_due': return 'yellow';
    case 'canceled': return 'gray';
    default: return 'red';
  }
}

/**
 * Billing Admin (system admin only). A fleet-wide view over every org's
 * subscription with per-row override + purge, a platform finance summary
 * (totals + per-org impact), and a one-off ledger backfill. All endpoints are
 * `requireSystemAdmin`; when the billing service is disabled they 404 and we
 * fall back to a "not enabled" empty state rather than an error banner.
 */
export default function BillingAdminPage() {
  const { user, isReady, isAuthenticated, isSuperAdmin } = useAuthGuard({ requireSystemAdmin: true });
  const toast = useToast();

  const [notEnabled, setNotEnabled] = useState(false);

  // ── Subscriptions list ─────────────────────────────────
  const list = useListPage<Subscription>({
    fields: [
      { key: 'status', type: 'select', defaultValue: 'all', primary: true },
    ],
    fetcher: async (params) => {
      const statusParam = String(params.status || 'all');
      try {
        const res = await api.listAdminSubscriptions({
          ...(statusParam !== 'all' && { status: statusParam }),
          offset: Number(params.offset || 0),
          limit: Number(params.limit || 25),
        });
        setNotEnabled(false);
        const data = res.data;
        return {
          items: data?.subscriptions || [],
          pagination: { total: data?.total ?? 0, offset: data?.offset ?? 0, limit: data?.limit ?? 25 },
        };
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 404) {
          setNotEnabled(true);
          return { items: [], pagination: { total: 0, offset: 0 } };
        }
        throw err;
      }
    },
    enabled: isAuthenticated && isSuperAdmin,
  });

  // ── Plans (for the edit modal's plan picker) ────────────
  const [plans, setPlans] = useState<Plan[]>([]);
  useEffect(() => {
    if (!isAuthenticated || !isSuperAdmin) return;
    api.getPlans()
      .then((res) => { if (res.success && res.data?.plans) setPlans(res.data.plans); })
      .catch(() => { /* plan picker just falls back to a free-text-less select */ });
  }, [isAuthenticated, isSuperAdmin]);

  // ── Platform finance summary ────────────────────────────
  const [summary, setSummary] = useState<AdminBillingSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  // Distinguishes a summary LOAD FAILURE from a genuinely empty window (a 500 must
  // not read as "No billing ledger data"). A 404 stays soft (billing disabled).
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const res = await api.getAdminBillingSummary({
        ...(from.trim() && { from: new Date(from.trim()).toISOString() }),
        ...(to.trim() && { to: new Date(to.trim()).toISOString() }),
      });
      if (res.success && res.data) setSummary(res.data);
    } catch (err) {
      // A 404 means billing isn't enabled — stay soft (the subscriptions table is
      // the primary surface). Any other error is a real load failure: surface it as
      // a retryable error rather than a misleading empty state.
      if (!(err instanceof ApiError && err.statusCode === 404)) {
        setSummaryError(formatError(err, 'Failed to load billing summary'));
      }
      setSummary(null);
    } finally {
      setSummaryLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    if (isAuthenticated && isSuperAdmin) void loadSummary();
    // Initial load only; the range Apply button re-fetches explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, isSuperAdmin]);

  // ── Edit subscription ───────────────────────────────────
  const [editSub, setEditSub] = useState<Subscription | null>(null);
  const [editPlanId, setEditPlanId] = useState('');
  const [editStatus, setEditStatus] = useState<SubscriptionStatus>('active');
  const [editInterval, setEditInterval] = useState<BillingInterval>('monthly');
  const [editCancelAtPeriodEnd, setEditCancelAtPeriodEnd] = useState(false);
  const editForm = useFormState();

  const openEdit = (sub: Subscription) => {
    setEditSub(sub);
    setEditPlanId(sub.planId);
    setEditStatus(sub.status);
    setEditInterval(sub.interval);
    setEditCancelAtPeriodEnd(sub.cancelAtPeriodEnd);
    editForm.reset();
  };

  const handleEdit = async () => {
    if (!editSub) return;
    // Send only what changed — planId in particular triggers a provider price
    // push + tier resync server-side, so don't send it when untouched.
    const body: AdminSubscriptionUpdate = {};
    if (editPlanId && editPlanId !== editSub.planId) body.planId = editPlanId;
    // Only send an admin-settable status (the select can surface a provider-only
    // `unpaid` for display, which the API would reject).
    if (editStatus !== editSub.status && (STATUS_OPTIONS as readonly string[]).includes(editStatus)) {
      body.status = editStatus as EditableStatus;
    }
    if (editInterval !== editSub.interval) body.interval = editInterval;
    if (editCancelAtPeriodEnd !== editSub.cancelAtPeriodEnd) body.cancelAtPeriodEnd = editCancelAtPeriodEnd;

    if (Object.keys(body).length === 0) {
      editForm.setError('No changes to save.');
      return;
    }
    const result = await editForm.run(() => api.updateAdminSubscription(editSub.id, body));
    if (result !== null) {
      setEditSub(null);
      list.refresh();
      void loadSummary();
      toast.success('Subscription updated');
    }
  };

  // ── Purge an org's subscription(s) ──────────────────────
  // Fleet-level destructive op (cancels every subscription at the provider +
  // deletes all rows/events) → gated behind a step-up password re-verify rather
  // than a plain two-button confirm. `purgeSub` holds the target while the
  // StepUpModal is open; the actual purge runs only after step-up succeeds.
  const [purgeSub, setPurgeSub] = useState<Subscription | null>(null);

  const handlePurge = async () => {
    if (!purgeSub) return;
    try {
      const res = await api.deleteSubscriptionByOrg(purgeSub.orgId);
      if (!res.success) throw new Error(res.message || 'Purge failed');
      toast.success(`Purged ${res.data?.deleted ?? 0} subscription(s) and ${res.data?.events ?? 0} event(s)`);
      list.refresh();
      void loadSummary();
    } catch (err) {
      list.setError(formatError(err, 'Failed to purge org subscription'));
    }
  };

  // ── Ledger backfill ─────────────────────────────────────
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);

  const handleBackfill = async () => {
    setBackfillLoading(true);
    try {
      const res = await api.runBillingBackfill();
      const r = res.data;
      toast.success(`Backfill complete — ${r?.ingested ?? 0} invoices across ${r?.accounts ?? 0} accounts (${r?.errors ?? 0} errors)`);
      setBackfillOpen(false);
      void loadSummary();
    } catch (err) {
      toast.error(formatError(err, 'Backfill failed'));
    } finally {
      setBackfillLoading(false);
    }
  };

  const columns: Column<Subscription>[] = useMemo(() => [
    {
      id: 'org',
      header: 'Organization',
      sortValue: (s) => s.orgId,
      render: (s) => (
        <div>
          <div className="font-mono text-xs text-gray-900 dark:text-gray-100 break-all">{s.orgId}</div>
          {s.cancelAtPeriodEnd && <Badge color="yellow">Cancels at period end</Badge>}
        </div>
      ),
    },
    {
      id: 'plan',
      header: 'Plan',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (s) => s.planName ?? s.planId,
      render: (s) => <span className="font-mono text-xs">{s.planName ?? s.planId}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (s) => s.status,
      render: (s) => <Badge color={statusColor(s.status)}>{s.status}</Badge>,
    },
    {
      id: 'interval',
      header: 'Interval',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (s) => s.interval,
      render: (s) => <span className="capitalize">{s.interval}</span>,
    },
    {
      id: 'periodEnd',
      header: 'Period End',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (s) => s.currentPeriodEnd ? new Date(s.currentPeriodEnd) : null,
      render: (s) => <RelativeTime value={s.currentPeriodEnd} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right text-sm font-medium',
      render: (s) => (
        <div className="flex justify-end gap-3">
          <button
            onClick={() => openEdit(s)}
            className="action-link inline-flex items-center gap-1"
            title="Override plan / status / interval"
          >
            <Pencil className="w-3.5 h-3.5" /> Edit
          </button>
          <button onClick={() => setPurgeSub(s)} className="action-link-danger">Purge</button>
        </div>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Billing Admin"
      subtitle="Fleet-wide subscriptions, platform finance, and ledger ops"
      titleExtra={<Badge color="red">System Admin</Badge>}
      actions={
        !notEnabled && (
          <Button variant="secondary" onClick={() => setBackfillOpen(true)}>
            <DatabaseZap className="w-4 h-4 mr-1.5" /> Backfill Ledger
          </Button>
        )
      }
    >
      <BillingAdminTabs active="admin" />
      <ErrorAlert message={list.error} onDismiss={() => list.setError(null)} />

      {notEnabled ? (
        <Card className="flex flex-col items-center text-center py-14">
          <div className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-gray-700/50 flex items-center justify-center">
            <ShieldAlert className="w-9 h-9 text-gray-400 dark:text-gray-500" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-gray-900 dark:text-gray-100">Billing is not enabled</h3>
          <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400 max-w-sm">
            The billing service is disabled in this deployment, so there is nothing to administer here.
          </p>
        </Card>
      ) : (
        <div className="space-y-8">
          {/* ── Platform finance summary ──────────────────── */}
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Platform Finance</h3>
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <label className="block text-[11px] font-medium text-gray-500 dark:text-gray-400">From</label>
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="text-sm" />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] font-medium text-gray-500 dark:text-gray-400">To</label>
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="text-sm" />
                </div>
                <Button variant="secondary" onClick={loadSummary} loading={summaryLoading}>
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Apply
                </Button>
              </div>
            </div>

            {summary ? (
              <>
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  <SummaryStat label="Gross billed" value={formatCents(summary.totals.grossBilledCents)} />
                  <SummaryStat label="Discounts" value={`-${formatCents(summary.totals.discountsCents)}`} />
                  <SummaryStat label="Credits" value={`-${formatCents(summary.totals.creditsCents)}`} />
                  <SummaryStat label="Net billed" value={formatCents(summary.totals.netBilledCents)} accent />
                  <SummaryStat label="Amount paid" value={formatCents(summary.totals.amountPaidCents)} />
                </div>
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  {summary.invoiceCount} invoice{summary.invoiceCount !== 1 ? 's' : ''} across {summary.byOrg.length} account{summary.byOrg.length !== 1 ? 's' : ''}.
                </p>

                {summary.byOrg.length > 0 && (
                  <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                          <th className="py-2 pr-4">Account</th>
                          <th className="py-2 pr-4 text-right">Gross</th>
                          <th className="py-2 pr-4 text-right">Discounts</th>
                          <th className="py-2 pr-4 text-right">Credits</th>
                          <th className="py-2 pr-4 text-right">Net</th>
                          <th className="py-2 pr-4 text-right">Invoices</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.byOrg.map((o) => (
                          <tr key={o.orgId} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                            <td className="py-2 pr-4 font-mono text-xs text-gray-800 dark:text-gray-200 break-all">{o.orgId}</td>
                            <td className="py-2 pr-4 text-right text-gray-700 dark:text-gray-300">{formatCents(o.grossBilledCents)}</td>
                            <td className="py-2 pr-4 text-right text-gray-500 dark:text-gray-400">{formatCents(o.discountsCents)}</td>
                            <td className="py-2 pr-4 text-right text-gray-500 dark:text-gray-400">{formatCents(o.creditsCents)}</td>
                            <td className="py-2 pr-4 text-right font-medium text-gray-900 dark:text-gray-100">{formatCents(o.netBilledCents)}</td>
                            <td className="py-2 pr-4 text-right text-gray-500 dark:text-gray-400">{o.invoiceCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : summaryError ? (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300" role="alert">
                <span>{summaryError}</span>
                <button type="button" onClick={() => void loadSummary()} className="underline hover:no-underline">Retry</button>
              </div>
            ) : (
              <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
                {summaryLoading ? 'Loading summary…' : 'No billing ledger data for this window.'}
              </p>
            )}
          </Card>

          {/* ── Subscriptions table ───────────────────────── */}
          <div>
            <div className="filter-bar flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-1 flex-wrap" role="group" aria-label="Filter by status">
                {(['all', ...STATUS_OPTIONS] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => list.updateFilter('status', value)}
                    aria-pressed={String(list.filters.status) === value}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border capitalize transition-colors ${String(list.filters.status) === value
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                  >
                    {value === 'all' ? 'All' : value}
                  </button>
                ))}
              </div>
            </div>

            <DataTable
              data={list.data}
              columns={columns}
              isLoading={list.isLoading}
              emptyState={{ icon: CreditCard, title: 'No subscriptions', description: 'No subscriptions match this filter.' }}
              getRowKey={(s) => s.id}
              defaultSortColumn="org"
            />

            {!list.isLoading && list.pagination.total > 0 && (
              <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
            )}
          </div>
        </div>
      )}

      {/* Edit subscription */}
      {editSub && (
        <Modal
          title="Override Subscription"
          onClose={() => setEditSub(null)}
          footer={
            <ModalFooter
              onCancel={() => setEditSub(null)}
              onConfirm={handleEdit}
              confirmLabel="Save Changes"
              loading={editForm.loading}
            />
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Admin override for <span className="font-mono text-xs text-gray-700 dark:text-gray-300">{editSub.orgId}</span>.
            A plan or status change resyncs the org’s tier/entitlements. A status change into a terminal state does
            <strong> not</strong> stop provider billing — use the normal cancel flow for that.
          </p>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Plan</label>
              <Select
                value={editPlanId}
                onChange={(e) => setEditPlanId(e.target.value)}
                className="text-sm"
                disabled={editForm.loading}
              >
                {/* Keep the current planId selectable even if it's not in the active catalog. */}
                {plans.length === 0 && <option value={editSub.planId}>{editSub.planName ?? editSub.planId}</option>}
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Status</label>
                <Select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value as SubscriptionStatus)}
                  className="text-sm capitalize"
                  disabled={editForm.loading}
                >
                  {/* Surface a provider-only status (e.g. `unpaid`) that isn't admin-settable so the
                      picker reflects reality; selecting a settable value is what the API accepts. */}
                  {!(STATUS_OPTIONS as readonly string[]).includes(editStatus) && <option value={editStatus}>{editStatus} (current)</option>}
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Interval</label>
                <Select
                  value={editInterval}
                  onChange={(e) => setEditInterval(e.target.value as BillingInterval)}
                  className="text-sm capitalize"
                  disabled={editForm.loading}
                >
                  {INTERVAL_OPTIONS.map((i) => <option key={i} value={i}>{i}</option>)}
                </Select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 pt-1">
              <Checkbox
                checked={editCancelAtPeriodEnd}
                onChange={(e) => setEditCancelAtPeriodEnd(e.target.checked)}
                disabled={editForm.loading}
              />
              <span>Cancel at period end</span>
            </label>
          </div>
          {editForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{editForm.error}</p>}
        </Modal>
      )}

      {/* Purge confirm — step-up gated (fleet-level destructive). The purge runs
          from onConfirmed after the password re-verify; the endpoint doesn't
          require the token itself, so it's used purely as the confirmation gate. */}
      {purgeSub && (
        <StepUpModal
          action={`Purge all subscriptions and billing events for ${purgeSub.orgId} (cancels every subscription at the provider — cannot be undone)`}
          onConfirmed={handlePurge}
          onClose={() => setPurgeSub(null)}
        />
      )}

      {/* Backfill confirm */}
      {backfillOpen && (
        <Modal
          title="Backfill Ledger"
          onClose={() => setBackfillOpen(false)}
          footer={
            <ModalFooter
              onCancel={() => setBackfillOpen(false)}
              onConfirm={handleBackfill}
              confirmLabel="Run Backfill"
              loading={backfillLoading}
            />
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Seed the billing ledger from the payment provider’s historical invoices. This is idempotent —
            already-ingested invoices are skipped — and safe to re-run. It may take a moment for large fleets.
          </p>
        </Modal>
      )}
    </DashboardLayout>
  );
}

/** A single labelled figure in the platform-finance stat row. */
function SummaryStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white/60 dark:bg-gray-800/40 px-3 py-2.5">
      <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold ${accent ? 'text-blue-600 dark:text-blue-400' : 'text-gray-900 dark:text-gray-100'}`}>{value}</div>
    </div>
  );
}
