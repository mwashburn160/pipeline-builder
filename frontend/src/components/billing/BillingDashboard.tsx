import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { StatCard } from '@/components/reports/StatCard';
import { formatCents as money } from '@/lib/format';
import type { BillingSummary, BillingInvoiceRow, BillingAllocation } from '@/lib/api/domains/billing';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

const STATUS_COLOR: Record<string, string> = {
  paid: 'text-green-600 dark:text-green-400',
  open: 'text-yellow-600 dark:text-yellow-400',
  void: 'text-gray-400 dark:text-gray-500',
  uncollectible: 'text-red-600 dark:text-red-400',
};

/**
 * Billing dashboard — historical actuals from the ledger: gross billed →
 * discounts/credits → net, a per-period bar, and an invoice table. Self-fetches
 * on mount and renders nothing until there's at least one invoice, so it stays
 * invisible for brand-new accounts with no billing history yet.
 */
export function BillingDashboard() {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [invoices, setInvoices] = useState<BillingInvoiceRow[]>([]);
  const [allocation, setAllocation] = useState<BillingAllocation | null>(null);
  const [loading, setLoading] = useState(true);
  // Latch: once we've seen ANY billing history, keep the section (and its range
  // picker) mounted — so a range filter that yields nothing can still be widened
  // again. Brand-new accounts with no history ever stay invisible (return null).
  const [hasHistory, setHasHistory] = useState(false);
  // Applied historical range (ISO `yyyy-mm-dd`); empty string = unbounded on that side.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // Monotonic token: a rapid range change (or unmount) must not let an older
  // in-flight load's response overwrite the latest one (last-write-wins /
  // setState-after-unmount). Only the newest request applies its results.
  const loadGenRef = useRef(0);

  const load = useCallback(async (f: string, t: string) => {
    const gen = ++loadGenRef.current;
    setLoading(true);
    const range = { ...(f ? { from: f } : {}), ...(t ? { to: t } : {}) };
    const [s, inv, alloc] = await Promise.all([
      api.getBillingSummary(range).catch(() => null),
      api.listBillingInvoices({ ...range, limit: 24 }).catch(() => null),
      // Cost-by-team showback — only meaningful for a rollup-capable admin of a
      // parent org with teams; 400s / single-org silently yield nothing.
      api.getBillingAllocation({ ...range, includeDescendants: true }).catch(() => null),
    ]);
    if (loadGenRef.current !== gen) return; // superseded by a newer range / unmounted
    setSummary(s?.data ?? null);
    setInvoices(inv?.data?.invoices ?? []);
    setAllocation(alloc?.data ?? null);
    if ((s?.data?.invoiceCount ?? 0) > 0) setHasHistory(true);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(from, to);
    // Invalidate any in-flight load on range change / unmount so its late
    // response is ignored.
    return () => { loadGenRef.current++; };
  }, [load, from, to]);

  // Hide entirely until this account has had billing history at least once.
  if (!hasHistory && (loading || !summary || summary.invoiceCount === 0)) return null;

  const isFiltered = !!(from || to);

  // Historical date-range filter — drives the summary, per-period bars, invoice
  // table, and cost-by-team allocation (all backend from/to aware). Rendered in
  // both the empty and data states so an over-narrow range can always be widened.
  const rangeToolbar = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Amounts billed</h2>
      <div className="flex items-center gap-2 text-sm">
        <label className="text-gray-500 dark:text-gray-400" htmlFor="billing-from">From</label>
        <Input
          id="billing-from" type="date" value={from} max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-gray-900 dark:text-gray-100"
        />
        <label className="text-gray-500 dark:text-gray-400" htmlFor="billing-to">To</label>
        <Input
          id="billing-to" type="date" value={to} min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-gray-900 dark:text-gray-100"
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
        <Card className="text-sm text-gray-500 dark:text-gray-400">
          {loading ? 'Loading…' : isFiltered ? 'No billing activity in the selected range.' : 'No billing activity yet.'}
        </Card>
      </div>
    );
  }

  const t = summary.totals;
  const maxGross = Math.max(1, ...summary.timeline.map((p) => p.grossCents));

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
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Billed by period</h3>
          <div className="space-y-1.5">
            {summary.timeline.map((p) => {
              const netPct = Math.round((p.netCents / maxGross) * 100);
              const creditPct = Math.round(((p.creditCents + p.discountCents) / maxGross) * 100);
              return (
                <div key={p.periodStart} className="flex items-center gap-3">
                  <span className="text-xs text-gray-400 dark:text-gray-500 w-20 shrink-0 tabular-nums">{fmtDate(p.periodStart)}</span>
                  <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden flex">
                    <div className="h-full bg-blue-500" style={{ width: `${netPct}%` }} title={`Net ${money(p.netCents)}`} />
                    <div className="h-full bg-emerald-400" style={{ width: `${creditPct}%` }} title={`Discounts + credits ${money(p.creditCents + p.discountCents)}`} />
                  </div>
                  <span className="text-xs tabular-nums w-16 text-right text-gray-600 dark:text-gray-300">{money(p.netCents)}</span>
                </div>
              );
            })}
            <div className="flex items-center gap-3 mt-2 text-xs text-gray-400 dark:text-gray-500">
              <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-500" /> Net</span>
              <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-400" /> Discounts + credits</span>
            </div>
          </div>
        </Card>
      )}

      <Card className="overflow-x-auto">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Invoices</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-400 dark:text-gray-500 text-left">
              <th className="py-1.5 pr-4 font-medium">Period</th>
              <th className="py-1.5 pr-4 font-medium text-right">Gross</th>
              <th className="py-1.5 pr-4 font-medium text-right">Discount</th>
              <th className="py-1.5 pr-4 font-medium text-right">Credit</th>
              <th className="py-1.5 pr-4 font-medium text-right">Tax</th>
              <th className="py-1.5 pr-4 font-medium text-right">Net</th>
              <th className="py-1.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {invoices.map((r) => (
              <tr key={`${r.periodStart}|${r.periodEnd}|${r.status}`} className="border-t border-gray-100 dark:border-gray-800">
                <td className="py-1.5 pr-4 text-gray-600 dark:text-gray-300">{fmtDate(r.periodStart)}</td>
                <td className="py-1.5 pr-4 text-right">{money(r.grossCents)}</td>
                <td className="py-1.5 pr-4 text-right text-gray-500 dark:text-gray-400">{r.discountCents ? `−${money(r.discountCents)}` : '—'}</td>
                <td className="py-1.5 pr-4 text-right text-gray-500 dark:text-gray-400">{r.creditCents ? `−${money(r.creditCents)}` : '—'}</td>
                <td className="py-1.5 pr-4 text-right text-gray-500 dark:text-gray-400">{r.taxCents ? money(r.taxCents) : '—'}</td>
                <td className="py-1.5 pr-4 text-right font-medium text-gray-900 dark:text-gray-100">{money(r.netCents)}</td>
                <td className={`py-1.5 capitalize ${STATUS_COLOR[r.status] ?? ''}`}>{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {allocation && allocation.rows.length > 1 && (
        <Card className="overflow-x-auto">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Cost by team</h3>
            <span className="text-xs text-gray-400 dark:text-gray-500">Estimated allocation · by {allocation.driver}</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-400 dark:text-gray-500 text-left">
                <th className="py-1.5 pr-4 font-medium">Team</th>
                <th className="py-1.5 pr-4 font-medium text-right">{allocation.driver}</th>
                <th className="py-1.5 pr-4 font-medium text-right">Share</th>
                <th className="py-1.5 pr-4 font-medium text-right">Credits</th>
                <th className="py-1.5 font-medium text-right">Net</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {allocation.rows.map((r) => (
                <tr key={r.orgId} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="py-1.5 pr-4 text-gray-600 dark:text-gray-300 font-mono text-xs">{r.orgId}</td>
                  <td className="py-1.5 pr-4 text-right">{r.driverUnits}</td>
                  <td className="py-1.5 pr-4 text-right text-gray-500 dark:text-gray-400">{r.sharePct}%</td>
                  <td className="py-1.5 pr-4 text-right text-gray-500 dark:text-gray-400">{r.creditCents ? `−${money(r.creditCents)}` : '—'}</td>
                  <td className="py-1.5 text-right font-medium text-gray-900 dark:text-gray-100">{money(r.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
