// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Logs — search, histogram, entry detail, raw view and download over the
 * Loki-backed application logs.
 *
 * Tenancy is enforced entirely server-side (the Loki tenant header is derived
 * from the caller's verified token), so nothing on this page is a security
 * control: an org sees only its own lines whatever it asks for, and that holds
 * identically for the raw view and the download. The one org-aware bit of UI is
 * cosmetic — sysadmins get an org column and a tenant selector.
 */

import { useCallback, useMemo, useState } from 'react';
import { Download, FileText, Loader2, RefreshCw, ScrollText, Search } from 'lucide-react';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage } from '@/components/ui/Loading';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { WarningAlert } from '@/components/ui/WarningAlert';
import { Modal } from '@/components/ui/Modal';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { LogEntryRow } from '@/components/observability/LogEntryRow';
import { LogVolumeChart } from '@/components/observability/LogVolumeChart';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useLogSearch, useLogVolume } from '@/hooks/useLogSearch';
import { api } from '@/lib/api';
import { triggerBlobDownload } from '@/lib/csv-export';
import { formatError } from '@/lib/constants';
import type { LogEntry, LogQueryParams, LogRangePreset, LogWindow } from '@/types/logs';

const PRESETS: Array<{ value: LogRangePreset; label: string }> = [
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
];

/** Shown under the search box — the syntax is parsed server-side against an allow-list. */
const SYNTAX_HINT = 'level:error service:platform "connection refused" -healthz /timed? out/';

export default function LogsPage() {
  // Viewing rides `observability:read`, which is in the built-in member bundle.
  const { accessDenied, isReady, isAuthenticated, user, can } = useAuthGuard();

  const [queryInput, setQueryInput] = useState('');
  // Applied separately from the input so typing doesn't fire a query per keystroke.
  const [applied, setApplied] = useState('');
  const [window, setWindow] = useState<LogWindow>({ kind: 'preset', key: '1h' });
  const [wrap, setWrap] = useState(false);
  const [limit, setLimit] = useState(200);
  const [rawText, setRawText] = useState<string | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [context, setContext] = useState<{ anchor: LogEntry; before: LogEntry[]; after: LogEntry[] } | null>(null);

  const isSysadmin = user?.isSuperAdmin === true;

  const params: LogQueryParams = useMemo(
    () => ({ window, q: applied || undefined, limit }),
    [window, applied, limit],
  );

  const { data, loading, error, refresh } = useLogSearch(params, isAuthenticated);
  const { data: volume, loading: volumeLoading } = useLogVolume(params, isAuthenticated);

  const entries = data?.entries ?? [];
  const served = data?.window;

  const applyQuery = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setApplied(queryInput.trim());
  }, [queryInput]);

  /** Zoom the window to one histogram bucket. */
  const zoomTo = useCallback((fromMs: number, toMs: number) => {
    setWindow({ kind: 'absolute', fromMs, toMs });
  }, []);

  const openRaw = useCallback(async () => {
    setRawLoading(true);
    setActionError(null);
    try {
      setRawText(await api.logRaw(params));
    } catch (err) {
      setActionError(formatError(err));
    } finally {
      setRawLoading(false);
    }
  }, [params]);

  const download = useCallback(async (format: 'log' | 'jsonl') => {
    setDownloading(true);
    setActionError(null);
    try {
      // The server streams the SAME compiled query as the on-screen search, with
      // the same tenant scope and masking — the download is not a second path.
      const { blob, filename } = await api.logExport({ ...params, format });
      triggerBlobDownload(blob, filename);
    } catch (err) {
      setActionError(formatError(err));
    } finally {
      setDownloading(false);
    }
  }, [params]);

  const showContext = useCallback(async (anchor: LogEntry) => {
    setActionError(null);
    try {
      const res = await api.logContext({ ...params, at: anchor.time });
      setContext({ anchor, before: res.data?.before ?? [], after: res.data?.after ?? [] });
    } catch (err) {
      setActionError(formatError(err));
    }
  }, [params]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !isAuthenticated) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Logs"
      subtitle={isSysadmin
        ? 'Application logs across the platform. Select organizations to widen the view.'
        : "Your organization's application logs."}
      maxWidth="7xl"
      actions={(
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={openRaw} loading={rawLoading}>
            <FileText className="mr-1 h-3.5 w-3.5" /> View as text
          </Button>
          {/* Download is gated on `logs:export`, not `observability:read`: bulk
              egress is a different risk class from paging the list on screen. */}
          {can('logs:export') && (
            <>
              <Button variant="outline" size="sm" onClick={() => download('log')} loading={downloading}>
                <Download className="mr-1 h-3.5 w-3.5" /> .log
              </Button>
              <Button variant="outline" size="sm" onClick={() => download('jsonl')} loading={downloading}>
                <Download className="mr-1 h-3.5 w-3.5" /> .jsonl
              </Button>
            </>
          )}
        </div>
      )}
    >
      {actionError && <ErrorAlert message={actionError} className="mb-4" />}
      {error && <ErrorAlert message={formatError(error)} className="mb-4" />}
      {data?.degraded && (
        <WarningAlert
          className="mb-4"
          message="Log backend unavailable — Loki is not reachable (this deployment may be running in LEAN mode, which omits it)."
        />
      )}
      {served?.clamped && (
        <WarningAlert
          className="mb-4"
          message="The requested window was wider than the 7-day log retention, so it was narrowed to the last 7 days."
        />
      )}

      <Card className="mb-4">
        <form onSubmit={applyQuery} className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden />
            <input
              type="text"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder={SYNTAX_HINT}
              aria-label="Search logs"
              className="w-full rounded border border-gray-300 bg-white py-1.5 pl-8 pr-2 font-mono text-xs dark:border-gray-600 dark:bg-gray-900"
            />
          </div>

          <FilterSelect
            aria-label="Time range"
            value={window.kind === 'preset' ? window.key : 'custom'}
            onChange={(e) => {
              const v = e.target.value;
              if (v !== 'custom') setWindow({ kind: 'preset', key: v as LogRangePreset });
            }}
          >
            {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            {window.kind === 'absolute' && <option value="custom">Custom range</option>}
          </FilterSelect>

          <FilterSelect aria-label="Max entries" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[100, 200, 500, 1000].map((n) => <option key={n} value={n}>{n} lines</option>)}
          </FilterSelect>

          <Button type="submit" size="sm">Search</Button>
        </form>

        {window.kind === 'absolute' && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Custom range: {new Date(window.fromMs).toLocaleString([], { hour12: false })} → {new Date(window.toMs).toLocaleString([], { hour12: false })}
            {' '}
            <button type="button" className="text-blue-600 hover:underline dark:text-blue-400" onClick={() => setWindow({ kind: 'preset', key: '1h' })}>
              reset
            </button>
          </p>
        )}
      </Card>

      <Card className="mb-4">
        <LogVolumeChart data={volume ?? undefined} loading={volumeLoading} onSelectBucket={zoomTo} />
      </Card>

      <Card className="!p-0">
        <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
          <span>
            {loading ? 'Loading…' : `${entries.length.toLocaleString()} entries`}
            {entries.length >= limit && ' (limit reached — narrow the query or raise the limit)'}
          </span>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
            Wrap lines
          </label>
        </div>

        {entries.length === 0 && !loading ? (
          <div className="p-6">
            <EmptyState
              icon={ScrollText}
              title="No matching log entries"
              description={isSysadmin
                ? 'Nothing matched in this window. Unattributed platform lines live in the _infra tenant.'
                : "Nothing matched in this window. Only lines your organization produced appear here — platform infrastructure logs are not included."}
              illustration="search"
            />
          </div>
        ) : (
          <div className="max-h-[32rem] overflow-auto">
            {entries.map((entry, i) => (
              <LogEntryRow
                key={`${entry.time}-${i}`}
                entry={entry}
                wrap={wrap}
                showOrg={isSysadmin}
                onShowContext={showContext}
              />
            ))}
          </div>
        )}
      </Card>

      {rawText !== null && (
        <Modal title="Log extract (text)" onClose={() => setRawText(null)} maxWidth="max-w-5xl" tall>
          <pre className="overflow-auto whitespace-pre-wrap break-all rounded bg-gray-950 p-3 font-mono text-xs text-gray-100">
            {rawText}
          </pre>
        </Modal>
      )}

      {context && (
        <Modal title="Context" onClose={() => setContext(null)} maxWidth="max-w-5xl" tall>
          <div className="font-mono text-xs">
            {context.before.map((e, i) => <LogEntryRow key={`b-${i}`} entry={e} wrap showOrg={isSysadmin} />)}
            <div className="my-1 border-y-2 border-blue-400 bg-blue-50 dark:bg-blue-950/40">
              <LogEntryRow entry={context.anchor} wrap showOrg={isSysadmin} />
            </div>
            {context.after.map((e, i) => <LogEntryRow key={`a-${i}`} entry={e} wrap showOrg={isSysadmin} />)}
            {context.before.length === 0 && context.after.length === 0 && (
              <p className="p-4 text-center text-gray-500 dark:text-gray-400">
                <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" aria-hidden />
                No surrounding entries in this stream.
              </p>
            )}
          </div>
        </Modal>
      )}
    </DashboardLayout>
  );
}
