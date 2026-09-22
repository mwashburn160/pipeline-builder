// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { ChevronRight, ChevronDown, Activity } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { COPY_FEEDBACK_RESET_MS } from '@/lib/constants';
import { normalizeLevel, type LogEntry, type LogLevel } from '@/types/logs';

/**
 * One log line, expandable into its detail view.
 *
 * Not a `DataTable` row: `DataTable` has no expandable-row support, and a log
 * row is a monospace line with a severity rail rather than a set of columns.
 */

const RAIL: Record<LogLevel | 'unknown', string> = {
  error: 'bg-red-500',
  warn: 'bg-amber-500',
  info: 'bg-emerald-500',
  debug: 'bg-gray-400',
  unknown: 'bg-gray-300 dark:bg-gray-600',
};

const LEVEL_TEXT: Record<LogLevel | 'unknown', string> = {
  error: 'text-red-600 dark:text-red-400',
  warn: 'text-amber-600 dark:text-amber-400',
  info: 'text-emerald-700 dark:text-emerald-400',
  debug: 'text-fg-muted',
  unknown: 'text-fg-muted',
};

/** Labels rendered as the inline prefix; the rest go in the detail table. */
const INLINE_LABELS = ['service_name', 'service', 'pod', 'container'];

interface LogEntryRowProps {
  entry: LogEntry;
  /** Wrap long lines instead of truncating them. */
  wrap: boolean;
  /** Sysadmins see which org a line belongs to; tenants only ever see their own. */
  showOrg: boolean;
  /** "Show context" — lines either side of this one in the same stream. */
  onShowContext?: (entry: LogEntry) => void;
}

export function LogEntryRow({ entry, wrap, showOrg, onShowContext }: LogEntryRowProps) {
  const [open, setOpen] = useState(false);
  const { state: jsonCopyState, copy: copyJson } = useCopyToClipboard(COPY_FEEDBACK_RESET_MS);
  const level = normalizeLevel(entry.labels.level) ?? 'unknown';
  const source = INLINE_LABELS.map((k) => entry.labels[k]).find(Boolean);
  const traceId = entry.labels.trace_id;

  return (
    <div className="border-b border-gray-100 last:border-0 dark:border-gray-800">
      <div className="flex items-stretch gap-2 hover:bg-surface-muted">
        <span className={`w-0.5 shrink-0 ${RAIL[level]}`} aria-hidden />

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex shrink-0 items-start pt-1 text-fg-subtle hover:text-fg"
          aria-expanded={open}
          aria-label={open ? 'Hide log entry details' : 'Show log entry details'}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        <div className={`min-w-0 flex-1 py-1 pr-2 font-mono text-xs ${wrap ? 'break-all' : 'truncate'}`}>
          <time
            dateTime={new Date(entry.time).toISOString()}
            title={new Date(entry.time).toISOString()}
            className="mr-2 text-fg-subtle"
          >
            {new Date(entry.time).toLocaleTimeString([], { hour12: false })}
          </time>
          {level !== 'unknown' && (
            <span className={`mr-2 uppercase ${LEVEL_TEXT[level]}`}>{level}</span>
          )}
          {source && <span className="mr-2 text-brand">{source}</span>}
          {showOrg && entry.labels.orgId && (
            <span className="mr-2 text-purple-600 dark:text-purple-400">{entry.labels.orgId}</span>
          )}
          <span className="text-gray-800 dark:text-gray-200">{entry.line}</span>
        </div>
      </div>

      {open && (
        <div className="bg-gray-50 px-8 py-3 dark:bg-gray-900/50">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <CopyButton text={entry.line} />
            <Button
              variant="outline"
              size="xs"
              onClick={() => copyJson(JSON.stringify({ time: entry.time, line: entry.line, labels: entry.labels }, null, 2))}
            >
              {jsonCopyState === 'copied' ? 'Copied JSON' : 'Copy as JSON'}
            </Button>
            {onShowContext && (
              <button
                type="button"
                onClick={() => onShowContext(entry)}
                className="text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                Show context
              </button>
            )}
            {traceId && (
              // Every line carries `trace_id` (the logger stamps it from the
              // active OTel span), so the jump to the trace is free.
              <Link
                href={`/dashboard/observability/traces?traceId=${encodeURIComponent(traceId)}`}
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                <Activity className="h-3 w-3" /> View trace
              </Link>
            )}
          </div>

          <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1 font-mono text-xs">
            <dt className="text-fg-muted">timestamp</dt>
            <dd className="break-all text-gray-800 dark:text-gray-200">{new Date(entry.time).toISOString()}</dd>
            {Object.entries(entry.labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-fg-muted">{k}</dt>
                <dd className="break-all text-gray-800 dark:text-gray-200">{v}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-3 whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-xs text-gray-800 dark:bg-gray-950 dark:text-gray-200">
            {entry.line}
          </p>
        </div>
      )}
    </div>
  );
}
