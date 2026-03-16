import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Download, Timer } from 'lucide-react';
import { Skeleton } from '@/components/ui/Skeleton';

// ─── Formatting ─────────────────────────────────────────

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Shared Components ──────────────────────────────────

export function ReportEmpty({ text }: { text: string }) {
  return <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">{text}</p>;
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="section-title text-sm tracking-tight mb-3">{children}</h3>;
}

/** Skeleton cards matching the summary stat card layout. */
export function StatCardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className={`grid grid-cols-2 sm:grid-cols-${count} gap-4`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card py-4 text-center">
          <Skeleton className="h-8 w-16 mx-auto mb-2" />
          <Skeleton className="h-3 w-20 mx-auto" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton matching a card with a section heading and content. */
export function SectionCardSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="card">
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
    </div>
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
}

export function DateRangePicker({ from, to, onFromChange, onToChange }: DateRangePickerProps) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="date"
        value={from}
        onChange={(e) => onFromChange(e.target.value)}
        className="filter-select text-xs tabular-nums"
        title="From date"
      />
      <span className="text-xs text-gray-400">→</span>
      <input
        type="date"
        value={to}
        onChange={(e) => onToChange(e.target.value)}
        className="filter-select text-xs tabular-nums"
        title="To date"
      />
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
      <button onClick={onRefresh} disabled={loading} className="btn btn-secondary px-3 py-1.5 text-sm">
        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
      </button>
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
    const headers = Object.keys(data[0]);
    const rows = data.map(row => headers.map(h => {
      const val = row[h];
      const str = val === null || val === undefined ? '' : String(val);
      return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <button
      onClick={handleExport}
      disabled={data.length === 0}
      className="btn btn-ghost text-xs px-2.5 py-1.5"
      title="Export to CSV"
    >
      <Download className="w-3.5 h-3.5 mr-1" />
      CSV
    </button>
  );
}
