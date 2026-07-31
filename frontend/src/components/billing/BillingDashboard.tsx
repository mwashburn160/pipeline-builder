import { useEffect, useState } from 'react';
import api from '@/lib/api';
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

  useEffect(() => {
    let active = true;
    (async () => {
      const [s, inv, alloc] = await Promise.all([
        api.getBillingSummary().catch(() => null),
        api.listBillingInvoices({ limit: 24 }).catch(() => null),
        // Cost-by-team showback — only meaningful for a rollup-capable admin of a
        // parent org with teams; 400s / single-org silently yield nothing.
        api.getBillingAllocation({ includeDescendants: true }).catch(() => null),
      ]);
      if (!active) return;
      if (s?.data) setSummary(s.data);
      if (inv?.data) setInvoices(inv.data.invoices);
      if (alloc?.data) setAllocation(alloc.data);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  if (loading || !summary || summary.invoiceCount === 0) return null;

  const t = summary.totals;
  const maxGross = Math.max(1, ...summary.timeline.map((p) => p.grossCents));

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Amounts billed</h2>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard label="Total Billed" value={money(t.grossBilledCents)} />
        <StatCard label="Discounts" value={money(t.discountsCents)} />
        <StatCard label="Usage Credits" value={money(t.creditsCents)} />
        <StatCard label="Net Billed" value={money(t.netBilledCents)} />
        <StatCard label="Amount Paid" value={money(t.amountPaidCents)} />
      </div>

      {summary.timeline.length > 0 && (
        <div className="card">
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
        </div>
      )}

      <div className="card overflow-x-auto">
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
      </div>

      {allocation && allocation.rows.length > 1 && (
        <div className="card overflow-x-auto">
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
        </div>
      )}
    </div>
  );
}
