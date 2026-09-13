import { useState, useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { RefreshCw, Download, Timer, Lock } from 'lucide-react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip } from '@/components/ui/Tooltip';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { FEATURE_METADATA } from '@/lib/feature-flags';
import { downloadCsv } from '@/lib/csv-export';
import type { DoraLevel, DoraTrendPoint } from '@/lib/api/domains/reporting';
import { StatCard } from './StatCard';
import { CFR_ELEVATED_PCT, SPARKLINE_MIN_BAR_PCT, SPARKLINE_ZERO_BAR_PCT } from './constants';

// ─── Formatting ─────────────────────────────────────────


/**
 * Format an ISO date as "Jul 27" — but include the year ("Jul 27, 2025") when it
 * falls in a different calendar year than today, so long/older reporting windows
 * aren't ambiguous. Null → "—".
 */
export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === new Date().getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString(undefined, opts);
}

// ─── Shared Components ──────────────────────────────────

export function ReportEmpty({ text }: { text: string }) {
  return <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">{text}</p>;
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="section-title text-sm tracking-tight mb-3">{children}</h3>;
}

interface StackedTimelineBarProps {
  /** ISO period label rendered on the left (formatted via {@link fmtDate}). */
  period: string;
  succeeded: number;
  failed: number;
  /** Optional third (yellow) segment. Omit for a two-segment pass/fail bar. */
  canceled?: number;
}

/**
 * One period row of the stacked pass/fail(/cancel) timeline: a date label, a
 * flex track split into green/red[/yellow] segments proportional to the counts,
 * and the period total. Shared by the pipeline Execution Timeline and the plugin
 * Build Success Rate visuals (identical markup; canceled is pipeline-only).
 */
export function StackedTimelineBar({ period, succeeded, failed, canceled }: StackedTimelineBarProps) {
  const total = succeeded + failed + (canceled ?? 0);
  const sPct = total > 0 ? (succeeded / total) * 100 : 0;
  const fPct = total > 0 ? (failed / total) * 100 : 0;
  const cPct = total > 0 ? ((canceled ?? 0) / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-400 dark:text-gray-500 w-16 shrink-0 tabular-nums">{fmtDate(period)}</span>
      <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden flex">
        {sPct > 0 && <div className="h-full bg-green-500" style={{ width: `${sPct}%` }} />}
        {fPct > 0 && <div className="h-full bg-red-500" style={{ width: `${fPct}%` }} />}
        {cPct > 0 && <div className="h-full bg-yellow-400" style={{ width: `${cPct}%` }} />}
      </div>
      <span className="text-xs text-gray-400 dark:text-gray-500 w-12 text-right tabular-nums">{total}</span>
    </div>
  );
}

/** Map of supported column counts to Tailwind grid classes (avoids dynamic class generation). */
const gridColsClass: Record<number, string> = {
  1: 'sm:grid-cols-1',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
  5: 'sm:grid-cols-5',
  6: 'sm:grid-cols-6',
};

/** Skeleton cards matching the summary stat card layout. */
export function StatCardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className={`grid grid-cols-2 ${gridColsClass[count] ?? 'sm:grid-cols-4'} gap-4`}>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} className="py-4 text-center">
          <Skeleton className="h-8 w-16 mx-auto mb-2" />
          <Skeleton className="h-3 w-20 mx-auto" />
        </Card>
      ))}
    </div>
  );
}

/** Skeleton matching a card with a section heading and content. */
export function SectionCardSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <Card>
      <Skeleton className="h-4 w-32 mb-4" />
      <div className="space-y-3">
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-4 flex-1 rounded" />
            <Skeleton className="h-3 w-8" />
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Skeleton for a two-column card grid. */
export function TwoColumnSkeleton() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <SectionCardSkeleton lines={5} />
      <SectionCardSkeleton lines={5} />
    </div>
  );
}

// ─── Date Range Picker ──────────────────────────────────

interface DateRangePickerProps {
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  /** Effective cap on the selectable span in days (default 730 — the report
   *  hard-cap). A span past this warns the user (the backend also floors it). */
  maxRangeDays?: number;
}

/** Local `YYYY-MM-DD` for today, used as the `max` on both date inputs. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function DateRangePicker({ from, to, onFromChange, onToChange, maxRangeDays = 730 }: DateRangePickerProps) {
  const today = todayIso();
  // Warn (don't block) when the chosen span exceeds the effective cap — the
  // backend floors the window at the retention horizon, so a wider pick silently
  // returns less than asked; the truncation banner on the report explains it.
  const spanDays =
    from && to ? Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) : 0;
  const overCap = spanDays > maxRangeDays;
  return (
    <div className="flex items-center gap-2">
      <input
        type="date"
        value={from}
        max={to || today}
        onChange={(e) => onFromChange(e.target.value)}
        className="filter-select text-xs tabular-nums"
        title="From date"
      />
      <span className="text-xs text-gray-400">→</span>
      <input
        type="date"
        value={to}
        min={from || undefined}
        max={today}
        onChange={(e) => onToChange(e.target.value)}
        className="filter-select text-xs tabular-nums"
        title="To date"
      />
      {overCap && (
        <span className="text-xs text-amber-600 dark:text-amber-400" title={`Reports cap at ${maxRangeDays} days`}>
          &gt;{maxRangeDays}d — will be capped
        </span>
      )}
    </div>
  );
}

// ─── Auto-Refresh Toggle ────────────────────────────────

const REFRESH_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '30s', value: 30_000 },
  { label: '1m', value: 60_000 },
  { label: '5m', value: 300_000 },
];

interface AutoRefreshProps {
  onRefresh: () => void;
  loading: boolean;
}

export function AutoRefresh({ onRefresh, loading }: AutoRefreshProps) {
  const [interval, setInterval_] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (interval > 0) {
      timerRef.current = setInterval(onRefresh, interval);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [interval, onRefresh]);

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1 border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden">
        {REFRESH_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setInterval_(opt.value)}
            className={`px-2 py-1 text-xs font-medium transition-colors ${
              interval === opt.value
                ? 'bg-blue-600 text-white'
                : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {interval > 0 && (
        <Timer className="w-3.5 h-3.5 text-blue-500 animate-pulse" />
      )}
      <Button variant="secondary" onClick={onRefresh} disabled={loading} className="px-3 py-1.5 text-sm">
        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
      </Button>
    </div>
  );
}

// ─── CSV Export ──────────────────────────────────────────

interface ExportButtonProps {
  data: Record<string, unknown>[];
  filename: string;
}

export function ExportCSVButton({ data, filename }: ExportButtonProps) {
  const handleExport = () => {
    if (data.length === 0) return;
    // Delegate to the shared serializer — it owns the formula-injection defense,
    // newline/quote escaping (this inline copy missed `\n`), header quoting, and
    // the DOM-attached anchor (Firefox needs it) in ONE place.
    downloadCsv(data, Object.keys(data[0]), filename);
  };

  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={handleExport}
      disabled={data.length === 0}
      title="Export to CSV"
    >
      <Download className="w-3.5 h-3.5 mr-1" />
      CSV
    </Button>
  );
}
