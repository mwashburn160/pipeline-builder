import { useEffect, useState, useCallback, useMemo } from 'react';
import { Search, ScrollText, RefreshCw } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useDebounce } from '@/hooks/useDebounce';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DataTable, type Column } from '@/components/ui/DataTable';
import api from '@/lib/api';
import type { LogEntry } from '@/types';

const TIME_RANGES = [
  { label: 'Last 15m', ms: 15 * 60 * 1000 },
  { label: 'Last 1h', ms: 60 * 60 * 1000 },
  { label: 'Last 6h', ms: 6 * 60 * 60 * 1000 },
  { label: 'Last 24h', ms: 24 * 60 * 60 * 1000 },
  { label: 'Last 7d', ms: 7 * 24 * 60 * 60 * 1000 },
];

const LEVEL_COLORS: Record<string, 'green' | 'yellow' | 'red' | 'gray' | 'blue'> = {
  info: 'blue',
  warn: 'yellow',
  error: 'red',
  debug: 'gray',
};

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function getLogMessage(entry: LogEntry): string {
  const parsed = entry.parsed;
  if (parsed && typeof parsed.message === 'string') return parsed.message;
  if (parsed && typeof parsed.raw === 'string') return parsed.raw;
  return entry.line;
}

export default function LogsPage() {
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin } = useAuthGuard();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  const [timeRange, setTimeRange] = useState(TIME_RANGES[1].ms); // Default: 1h
  const [limit, setLimit] = useState(100);

  const [services, setServices] = useState<string[]>([]);
  const [levels, setLevels] = useState<string[]>([]);

  const debouncedSearch = useDebounce(searchQuery, 300);

  // Load filter options
  useEffect(() => {
    if (!isAuthenticated) return;
    api.getLogServices().then(res => setServices(res.data?.services || [])).catch(() => {});
    api.getLogLevels().then(res => setLevels(res.data?.levels || [])).catch(() => {});
  }, [isAuthenticated]);

  const fetchLogs = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setIsLoading(true);
      setError(null);
      const now = Date.now();
      const start = String(now - timeRange);
      const end = String(now);
      const params: Record<string, string> = { start, end, limit: String(limit), direction: 'backward' };
      if (serviceFilter) params.service = serviceFilter;
      if (levelFilter) params.level = levelFilter;
      if (debouncedSearch) params.search = debouncedSearch;
      const response = await api.getLogs(params);
      setEntries(response.data?.entries || []);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to load logs');
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated, serviceFilter, levelFilter, debouncedSearch, timeRange, limit]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const logColumns: Column<LogEntry>[] = useMemo(() => [
    {
      id: 'timestamp',
      header: 'Timestamp',
      headerClassName: 'w-44',
      cellClassName: 'text-xs font-mono text-gray-500 dark:text-gray-400 whitespace-nowrap',
      sortValue: (entry) => new Date(entry.timestamp),
      render: (entry) => <>{formatTimestamp(entry.timestamp)}</>,
    },
    {
      id: 'service',
      header: 'Service',
      headerClassName: 'w-28',
      sortValue: (entry) => (entry.parsed?.service as string) || entry.labels?.service_name || entry.labels?.service || '',
      render: (entry) => {
        const service = (entry.parsed?.service as string) || entry.labels?.service_name || entry.labels?.service || '';
        return service ? <Badge color="blue">{service}</Badge> : null;
      },
    },
    {
      id: 'level',
      header: 'Level',
      headerClassName: 'w-20',
      sortValue: (entry) => (entry.parsed?.level as string) || entry.labels?.level || '',
      render: (entry) => {
        const level = (entry.parsed?.level as string) || entry.labels?.level || '';
        return level ? <Badge color={LEVEL_COLORS[level] || 'gray'}>{level}</Badge> : null;
      },
    },
    {
      id: 'message',
      header: 'Message',
      cellClassName: 'text-sm text-gray-900 dark:text-gray-100 font-mono break-all',
      render: (entry) => <>{getLogMessage(entry)}</>,
    },
  ], []);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Service Logs"
      actions={
        <button onClick={fetchLogs} disabled={isLoading} className="btn btn-secondary text-sm py-1.5 flex items-center gap-1.5">
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      }
    >
      <RoleBanner isSysAdmin={isSysAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="logs" orgName={user.organizationName} />

      {error && (
        <div className="alert-error">
          <p>{error}</p>
          <button onClick={() => setError(null)} className="mt-2 text-sm text-red-600 dark:text-red-400 underline">Dismiss</button>
        </div>
      )}

      {/* Filters */}
      <div className="filter-bar">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
            <input type="text" placeholder="Search log messages..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="filter-input" />
          </div>
          <select value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)} className="filter-select">
            <option value="">All Services</option>
            {services.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)} className="filter-select">
            <option value="">All Levels</option>
            {levels.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <select value={timeRange} onChange={(e) => setTimeRange(Number(e.target.value))} className="filter-select">
            {TIME_RANGES.map(r => <option key={r.ms} value={r.ms}>{r.label}</option>)}
          </select>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="filter-select">
            <option value={50}>50 lines</option>
            <option value={100}>100 lines</option>
            <option value={250}>250 lines</option>
            <option value={500}>500 lines</option>
            <option value={1000}>1000 lines</option>
          </select>
        </div>
      </div>

      <DataTable
        data={entries}
        columns={logColumns}
        isLoading={isLoading}
        emptyState={{
          icon: ScrollText,
          title: 'No logs found',
          description: debouncedSearch || serviceFilter || levelFilter ? 'Try adjusting your filters.' : 'No log entries in the selected time range.',
        }}
        getRowKey={(entry, i) => `${entry.timestamp}-${i}`}
        animationDelay={0.02}
        maxAnimationDelay={0.5}
        defaultSortColumn="timestamp"
        defaultSortDirection="desc"
      />

      <div className="mt-4 text-sm text-gray-500 dark:text-gray-400">
        Showing {entries.length} log {entries.length === 1 ? 'entry' : 'entries'}
      </div>
    </DashboardLayout>
  );
}
