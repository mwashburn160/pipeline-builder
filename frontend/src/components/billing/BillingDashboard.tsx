import { useEffect, useState } from 'react';
import { Receipt, Users } from 'lucide-react';
import api from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { useFetch } from '@/hooks/useFetch';
import { StatCard } from '@/components/reports/StatCard';
import { formatCents as money } from '@/lib/format';
import type { BillingSummary, BillingInvoiceRow, BillingAllocation } from '@/lib/api/domains/billing';

type AllocationRow = BillingAllocation['rows'][number];

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

const INVOICE_PAGE_SIZE = 24;

const STATUS_COLOR: Record<string, string> = {
  paid: 'text-green-600 dark:text-green-400',
  open: 'text-yellow-600 dark:text-yellow-400',
  void: 'text-[var(--pb-text-muted)]',
  uncollectible: 'text-red-600 dark:text-red-400',
};

const INVOICE_COLUMNS: Column<BillingInvoiceRow>[] = [
  { id: 'period', header: 'Period', cellClassName: 'text-[var(--pb-text-muted)]', render: (r) => fmtDate(r.periodStart) },
  { id: 'gross', header: 'Gross', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (r) => money(r.grossCents) },
  { id: 'discount', header: 'Discount', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums text-[var(--pb-text-muted)]', render: (r) => (r.discountCents ? `−${money(r.discountCents)}` : '—') },
  { id: 'credit', header: 'Credit', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums text-[var(--pb-text-muted)]', render: (r) => (r.creditCents ? `−${money(r.creditCents)}` : '—') },
  { id: 'tax', header: 'Tax', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums text-[var(--pb-text-muted)]', render: (r) => (r.taxCents ? money(r.taxCents) : '—') },
  { id: 'net', header: 'Net', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums font-medium text-[var(--pb-text)]', render: (r) => money(r.netCents) },
  { id: 'status', header: 'Status', cellClassName: 'capitalize', render: (r) => <span className={STATUS_COLOR[r.status] ?? ''}>{r.status}</span> },
];

/**
 * Billing dashboard — historical actuals from the ledger: gross billed →
 * discounts/credits → net, a per-period bar, and an invoice table. Self-fetches
 * on mount and renders nothing until there's at least one invoice, so it stays
 * invisible for brand-new accounts with no billing history yet.
 */
export function BillingDashboard() {
  // Latch: once we've seen ANY billing history, keep the section (and its range
  // picker) mounted — so a range filter that yields nothing can still be widened
  // again. Brand-new accounts with no history ever stay invisible (return null).
  const [hasHistory, setHasHistory] = useState(false);
  // Applied historical range (ISO `yyyy-mm-dd`); empty string = unbounded on that side.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [invoicePage, setInvoicePage] = useState({ offset: 0, limit: INVOICE_PAGE_SIZE });
  const range = { ...(from ? { from } : {}), ...(to ? { to } : {}) };

  // Summary + cost-by-team for the range. useFetch drops a superseded range's
  // late answer, so a rapid range change can't paint stale totals.
  const { data: overview, loading } = useFetch(async (signal) => {
    const [s, alloc] = await Promise.all([
      api.getBillingSummary(range, { signal }).catch(() => null),
      // Cost-by-team showback — only meaningful for a rollup-capable admin of a
      // parent org with teams; 400s / single-org silently yield nothing.
      api.getBillingAllocation({ ...range, includeDescendants: true }, { signal }).catch(() => null),
    ]);
    return { summary: s?.data ?? null, allocation: alloc?.data ?? null };
  }, [from, to]);
  const summary: BillingSummary | null = overview?.summary ?? null;
  const allocation: BillingAllocation | null = overview?.allocation ?? null;

  // Invoices page through the server (the range can hold years of periods).
  const { data: invoicePageData } = useFetch(async (signal) => {
    const res = await api.listBillingInvoices({ ...range, ...invoicePage }, { signal }).catch(() => null);
    return { invoices: res?.data?.invoices ?? [], total: res?.data?.pagination?.total ?? 0 };
  }, [from, to, invoicePage.offset, invoicePage.limit]);
  const invoices: BillingInvoiceRow[] = invoicePageData?.invoices ?? [];
  const invoiceTotal = invoicePageData?.total ?? 0;

  useEffect(() => {
    if ((summary?.invoiceCount ?? 0) > 0) setHasHistory(true);
  }, [summary]);
  // A new range starts the invoice table from its first page.
  useEffect(() => {
    setInvoicePage((p) => (p.offset === 0 ? p : { ...p, offset: 0 }));
  }, [from, to]);

  // Hide entirely until this account has had billing history at least once.
  if (!hasHistory && (loading || !summary || summary.invoiceCount === 0)) return null;

  const isFiltered = !!(from || to);

  // Historical date-range filter — drives the summary, per-period bars, invoice
  // table, and cost-by-team allocation (all backend from/to aware). Rendered in
  // both the empty and data states so an over-narrow range can always be widened.
  const rangeToolbar = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold text-[var(--pb-text)]">Amounts billed</h2>
      <div className="flex items-center gap-2 text-sm">
        <label className="text-[var(--pb-text-muted)]" htmlFor="billing-from">From</label>
        <Input
          id="billing-from" type="date" value={from} max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
          className="rounded border border-[var(--pb-border)] bg-[var(--pb-surface)] px-2 py-1 text-[var(--pb-text)]"
        />
        <label className="text-[var(--pb-text-muted)]" htmlFor="billing-to">To</label>
        <Input
          id="billing-to" type="date" value={to} min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
          className="rounded border border-[var(--pb-border)] bg-[var(--pb-surface)] px-2 py-1 text-[var(--pb-text)]"
        />
        {isFiltered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setFrom(''); setTo(''); }}
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            Clear
          </Button>
        )}
      </div>
    </div>
  );

  // Direct `summary` checks (not a derived boolean) so TS narrows it to non-null
  // for the data render below.
  if (!summary || summary.invoiceCount === 0) {
    return (
      <div className="space-y-4">
        {rangeToolbar}
        <Card className="text-sm text-[var(--pb-text-muted)]">
          {loading ? 'Loading…' : isFiltered ? 'No billing activity in the selected range.' : 'No billing activity yet.'}
        </Card>
      </div>
    );
  }

  const t = summary.totals;
  const maxGross = Math.max(1, ...summary.timeline.map((p) => p.grossCents));

  const allocationColumns: Column<AllocationRow>[] = [
    { id: 'team', header: 'Team', cellClassName: 'text-[var(--pb-text-muted)] font-mono text-xs', render: (r) => r.orgId },
    { id: 'units', header: allocation?.driver ?? 'Units', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (r) => r.driverUnits },
    { id: 'share', header: 'Share', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums text-[var(--pb-text-muted)]', render: (r) => `${r.sharePct}%` },
    { id: 'credits', header: 'Credits', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums text-[var(--pb-text-muted)]', render: (r) => (r.creditCents ? `−${money(r.creditCents)}` : '—') },
    { id: 'net', header: 'Net', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums font-medium text-[var(--pb-text)]', render: (r) => money(r.netCents) },
  ];

  return (
    <div className="space-y-4">
      {rangeToolbar}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard label="Total Billed" value={money(t.grossBilledCents)} />
        <StatCard label="Discounts" value={money(t.discountsCents)} />
        <StatCard label="Usage Credits" value={money(t.creditsCents)} />
        <StatCard label="Net Billed" value={money(t.netBilledCents)} />
        <StatCard label="Amount Paid" value={money(t.amountPaidCents)} />
      </div>

      {summary.timeline.length > 0 && (
        <Card>
          <h3 className="text-sm font-medium text-[var(--pb-text)] mb-3">Billed by period</h3>
          <div className="space-y-1.5">
            {summary.timeline.map((p) => {
              const netPct = Math.round((p.netCents / maxGross) * 100);
              const creditPct = Math.round(((p.creditCents + p.discountCents) / maxGross) * 100);
              return (
                <div key={p.periodStart} className="flex items-center gap-3">
                  <span className="text-xs text-[var(--pb-text-muted)] w-20 shrink-0 tabular-nums">{fmtDate(p.periodStart)}</span>
                  <div className="flex-1 h-4 bg-[var(--pb-surface-muted)] rounded overflow-hidden flex">
                    <div className="h-full bg-blue-500" style={{ width: `${netPct}%` }} title={`Net ${money(p.netCents)}`} />
                    <div className="h-full bg-emerald-400" style={{ width: `${creditPct}%` }} title={`Discounts + credits ${money(p.creditCents + p.discountCents)}`} />
                  </div>
                  <span className="text-xs tabular-nums w-16 text-right text-[var(--pb-text-muted)]">{money(p.netCents)}</span>
                </div>
              );
            })}
            <div className="flex items-center gap-3 mt-2 text-xs text-[var(--pb-text-muted)]">
              <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-500" /> Net</span>
              <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-400" /> Discounts + credits</span>
            </div>
          </div>
        </Card>
      )}

      <Card className="overflow-x-auto">
        <h3 className="text-sm font-medium text-[var(--pb-text)] mb-3">Invoices</h3>
        <DataTable
          data={invoices}
          columns={INVOICE_COLUMNS}
          isLoading={false}
          animated={false}
          getRowKey={(r) => `${r.periodStart}|${r.periodEnd}|${r.status}`}
          emptyState={{ icon: Receipt, title: 'No invoices', description: 'No invoices in the selected range.' }}
        />
        {invoiceTotal > invoicePage.limit && (
          <Pagination
            pagination={{ ...invoicePage, total: invoiceTotal }}
            onPageChange={(offset) => setInvoicePage((p) => ({ ...p, offset }))}
            onPageSizeChange={(limit) => setInvoicePage({ offset: 0, limit })}
            pageSizeOptions={[12, 24, 48, 96]}
          />
        )}
      </Card>

      {allocation && allocation.rows.length > 1 && (
        <Card className="overflow-x-auto">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-[var(--pb-text)]">Cost by team</h3>
            <span className="text-xs text-[var(--pb-text-muted)]">Estimated allocation · by {allocation.driver}</span>
          </div>
          <DataTable
            data={allocation.rows}
            columns={allocationColumns}
            isLoading={false}
            animated={false}
            getRowKey={(r) => r.orgId}
            emptyState={{ icon: Users, title: 'No allocation', description: 'No cost allocation for the selected range.' }}
          />
        </Card>
      )}
    </div>
  );
}
