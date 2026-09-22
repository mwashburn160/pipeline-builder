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
import { Download, FileText, RefreshCw, ScrollText } from 'lucide-react';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage } from '@/components/ui/Loading';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { RetryError } from '@/components/ui/RetryError';
import { WarningAlert } from '@/components/ui/WarningAlert';
import { Modal } from '@/components/ui/Modal';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { SearchInput } from '@/components/ui/SearchInput';
import { LogEntryRow } from '@/components/observability/LogEntryRow';
import { LogVolumeChart } from '@/components/observability/LogVolumeChart';
import { OrgMultiPicker } from '@/components/ui/OrgPicker';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useLogSearch, useLogVolume } from '@/hooks/useLogSearch';
import { api } from '@/lib/api';
import { triggerBlobDownload } from '@/lib/csv-export';
import { formatError } from '@/lib/constants';
import { withoutAnchor } from '@/lib/log-context';
import type { LogEntry, LogQueryParams, LogRangePreset, LogWindow } from '@/types/logs';

const PRESETS: Array<{ value: LogRangePreset; label: string }> = [
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
];

/**
 * How far either side of an entry the "show context" drill-down reaches. The
 * server clamps `spanMs` at 600_000 (10 minutes), so that is the last option.
 */
const CONTEXT_SPANS: Array<{ value: number; label: string }> = [
  { value: 30_000, label: '± 30 seconds' },
  { value: 60_000, label: '± 1 minute' },
  { value: 300_000, label: '± 5 minutes' },
  { value: 600_000, label: '± 10 minutes' },
];
/** The server's own default when no `spanMs` is sent. */
const DEFAULT_CONTEXT_SPAN_MS = 60_000;

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
  // How far either side of an entry "show context" reaches. The endpoint has
  // always taken `spanMs` (and clamps it at 600s); this page never passed one,
  // so context was stuck at the 60s default — too narrow to see what a slow
  // request did before it failed.
  const [contextSpanMs, setContextSpanMs] = useState(DEFAULT_CONTEXT_SPAN_MS);
  // Name the export carries. The server sanitises it and puts it in
  // Content-Disposition; without one every download is `pipeline-builder-logs`,
  // so a folder of them is indistinguishable.
  const [exportName, setExportName] = useState('');
  const [context, setContext] = useState<{ anchor: LogEntry; before: LogEntry[]; after: LogEntry[] } | null>(null);

  const isSysadmin = user?.isSuperAdmin === true;
  // Sysadmin tenant selection. Empty = the server default (platform
  // infrastructure only); the subtitle promised a selector that didn't exist,
  // so a sysadmin could never read an org's lines from this page.
  const [orgs, setOrgs] = useState<string[]>([]);

  const params: LogQueryParams = useMemo(
    () => ({ window, q: applied || undefined, limit, ...(isSysadmin && orgs.length ? { orgs } : {}) }),
    [window, applied, limit, isSysadmin, orgs],
  );

  const { data, loading, error, refresh } = useLogSearch(params, isAuthenticated);
  const { data: volume, loading: volumeLoading, error: volumeError } = useLogVolume(params, isAuthenticated);

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
      const { blob, filename } = await api.logExport({
        ...params,
        format,
        ...(exportName.trim() ? { name: exportName.trim() } : {}),
      });
      triggerBlobDownload(blob, filename);
    } catch (err) {
      setActionError(formatError(err));
    } finally {
      setDownloading(false);
    }
  }, [params, exportName]);

  const showContext = useCallback(async (anchor: LogEntry) => {
    setActionError(null);
    try {
      const res = await api.logContext({ ...params, at: anchor.time, spanMs: contextSpanMs });
      setContext(withoutAnchor(anchor, res.data?.before ?? [], res.data?.after ?? []));
    } catch (err) {
      setActionError(formatError(err));
    }
  }, [params, contextSpanMs]);

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
              {/* The export endpoint takes a `name` (sanitised server-side into
                  Content-Disposition). Without one every download lands as
                  `pipeline-builder-logs`, which is useless in a folder of them. */}
              <SearchInput
                value={exportName}
                onChange={setExportName}
                onClear={() => setExportName('')}
                placeholder="Download name (optional)"
                aria-label="Download file name"
                containerClassName="w-48"
                className="text-xs"
              />
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
      {error && <RetryError message={formatError(error)} onRetry={refresh} className="mb-4" />}
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
          <SearchInput
            value={queryInput}
            onChange={setQueryInput}
            onClear={() => setQueryInput('')}
            placeholder={SYNTAX_HINT}
            aria-label="Search logs"
            containerClassName="min-w-0 flex-1"
            className="font-mono text-xs"
          />

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

        {isSysadmin && (
          <OrgMultiPicker
            value={orgs}
            onChange={setOrgs}
            aria-label="Organizations to read"
            className="mt-2"
          />
        )}

        {window.kind === 'absolute' && (
          <p className="mt-2 text-xs text-fg-muted">
            Custom range: {new Date(window.fromMs).toLocaleString([], { hour12: false })} → {new Date(window.toMs).toLocaleString([], { hour12: false })}
            {' '}
            <button type="button" className="text-blue-600 hover:underline dark:text-blue-400" onClick={() => setWindow({ kind: 'preset', key: '1h' })}>
              reset
            </button>
          </p>
        )}
      </Card>

      <Card className="mb-4">
        <LogVolumeChart data={volume ?? undefined} loading={volumeLoading} error={!!volumeError} onSelectBucket={zoomTo} />
      </Card>

      <Card className="!p-0">
        <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2 text-xs text-fg-muted dark:border-gray-800">
          <span>
            {loading ? 'Loading…' : error ? 'Search failed' : `${entries.length.toLocaleString()} entries`}
            {!error && entries.length >= limit && ' (limit reached — narrow the query or raise the limit)'}
          </span>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
            Wrap lines
          </label>
        </div>

        {/* A failed search is not "no matches" — the RetryError above says so. */}
        {entries.length === 0 && !loading && error ? null : entries.length === 0 && !loading ? (
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
          <div className="mb-2 flex items-center justify-end gap-2">
            <FilterSelect
              aria-label="Context window"
              value={contextSpanMs}
              onChange={(e) => {
                const span = Number(e.target.value);
                setContextSpanMs(span);
                // Re-read the SAME anchor at the new width, so widening is one
                // step rather than "close, change, find the line again".
                void (async () => {
                  setActionError(null);
                  try {
                    const res = await api.logContext({ ...params, at: context.anchor.time, spanMs: span });
                    setContext(withoutAnchor(context.anchor, res.data?.before ?? [], res.data?.after ?? []));
                  } catch (err) {
                    setActionError(formatError(err));
                  }
                })();
              }}
            >
              {CONTEXT_SPANS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </FilterSelect>
          </div>
          <div className="font-mono text-xs">
            {context.before.map((e, i) => <LogEntryRow key={`b-${i}`} entry={e} wrap showOrg={isSysadmin} />)}
            <div className="my-1 border-y-2 border-blue-400 bg-blue-50 dark:bg-blue-950/40">
              <LogEntryRow entry={context.anchor} wrap showOrg={isSysadmin} />
            </div>
            {context.after.map((e, i) => <LogEntryRow key={`a-${i}`} entry={e} wrap showOrg={isSysadmin} />)}
            {context.before.length === 0 && context.after.length === 0 && (
              <p className="p-4 text-center text-fg-muted">No surrounding entries in this stream.</p>
            )}
          </div>
        </Modal>
      )}
    </DashboardLayout>
  );
}
