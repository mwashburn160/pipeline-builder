// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { X, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { LOG_LEVEL_COLORS } from '@/lib/constants';
import type { LogEntry } from '@/types';

interface LogDetailsDrawerProps {
  /** When non-null, the drawer is open and shows this entry. */
  entry: LogEntry | null;
  onClose: () => void;
}

/**
 * Right-edge side drawer that shows the full structured contents of a Loki log
 * entry — the parsed-JSON fields, the Loki labels promtail attached, the raw
 * line for cases where parsing fell back, and any stack trace. Wider than a
 * Modal so multi-line stacks don't wrap aggressively; mounted via fixed
 * positioning so it overlays the page without forcing a re-layout of the
 * table behind it.
 *
 * Closes on Escape, on backdrop click, and on the X button. Focus is moved
 * to the close button on open and restored to the previously-focused element
 * on close (the row that opened it).
 */
export function LogDetailsDrawer({ entry, onClose }: LogDetailsDrawerProps) {
  const previousActiveElement = useRef<Element | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Stable handlers — `onClose` is stable across re-renders in callers and
  // we don't want to re-bind the keydown listener on every entry change.
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (!entry) return;
    previousActiveElement.current = document.activeElement;
    document.addEventListener('keydown', handleKeyDown);
    // Focus the close button on open so the drawer is keyboard-controllable
    // without first tabbing through the table.
    closeButtonRef.current?.focus();
    // Prevent background scroll while the drawer is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = prevOverflow;
      // Restore focus to the trigger row if it is still in the DOM.
      const prev = previousActiveElement.current;
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
    };
  }, [entry, handleKeyDown]);

  if (!entry) return null;

  return (
    <div
      className="fixed inset-0 z-40"
      role="presentation"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" />
      {/* Drawer panel */}
      <aside
        className="absolute top-0 right-0 h-full w-full max-w-2xl bg-white dark:bg-gray-900 shadow-2xl flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Log entry details"
        onClick={(e) => e.stopPropagation()}
      >
        <DrawerHeader entry={entry} onClose={onClose} closeButtonRef={closeButtonRef} />
        <DrawerBody entry={entry} />
      </aside>
    </div>
  );
}

function DrawerHeader(props: {
  entry: LogEntry;
  onClose: () => void;
  closeButtonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { entry, onClose, closeButtonRef } = props;
  const level = pickLevel(entry);
  const service = pickService(entry);

  return (
    <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          {service && <Badge color="blue">{service}</Badge>}
          {level && <Badge color={LOG_LEVEL_COLORS[level] || 'gray'}>{level}</Badge>}
          <span className="text-xs font-mono text-gray-500 dark:text-gray-400 tabular-nums">
            {new Date(entry.timestamp).toLocaleString()}
          </span>
        </div>
        <h2 className="text-sm font-mono text-gray-900 dark:text-gray-100 break-all">
          {getMessage(entry)}
        </h2>
      </div>
      <button
        ref={closeButtonRef}
        onClick={onClose}
        aria-label="Close details"
        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors flex-shrink-0"
      >
        <X className="w-5 h-5" />
      </button>
    </div>
  );
}

function DrawerBody({ entry }: { entry: LogEntry }) {
  // Split parsed fields into "interesting" (the structured logger payload —
  // org_id, requestId, pluginName, durationMs, ...) and "boilerplate"
  // (level/service/message already shown in the header). Stacktraces and
  // errors get their own block so they render with newlines preserved.
  const HEADER_KEYS = new Set(['level', 'message', 'msg', 'service', 'service_name', 'timestamp', 'ts', 'time']);
  const STACK_KEYS = new Set(['stack', 'stacktrace', 'error.stack', 'errorStack']);

  const parsedEntries = Object.entries(entry.parsed || {});
  const stackEntries = parsedEntries.filter(([k]) => STACK_KEYS.has(k));
  const fieldEntries = parsedEntries
    .filter(([k]) => !HEADER_KEYS.has(k) && !STACK_KEYS.has(k))
    .sort(([a], [b]) => a.localeCompare(b));

  const labelEntries = Object.entries(entry.labels || {})
    .filter(([k]) => !['service', 'service_name', 'level'].includes(k))
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
      {fieldEntries.length > 0 && (
        <Section title="Fields">
          <FieldList rows={fieldEntries} />
        </Section>
      )}

      {labelEntries.length > 0 && (
        <Section title="Labels">
          <FieldList rows={labelEntries} mono />
        </Section>
      )}

      {stackEntries.map(([k, v]) => (
        <Section key={k} title={k}>
          <CopyableBlock content={typeof v === 'string' ? v : JSON.stringify(v, null, 2)} preformatted />
        </Section>
      ))}

      <Section title="Raw line">
        <CopyableBlock content={entry.line} preformatted />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
        {title}
      </h3>
      {children}
    </section>
  );
}

function FieldList({ rows, mono = false }: { rows: Array<[string, unknown]>; mono?: boolean }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-gray-500 dark:text-gray-400 font-mono whitespace-nowrap pt-0.5">{k}</dt>
          <dd className={`${mono ? 'font-mono' : ''} text-gray-900 dark:text-gray-100 break-all`}>
            {renderValue(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Render an arbitrary unknown value: primitives become text, objects render
 * as pretty-printed JSON with monospace + wrapping.
 */
function renderValue(v: unknown): ReactNode {
  if (v == null) return <span className="text-gray-400">—</span>;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return (
    <pre className="whitespace-pre-wrap font-mono text-xs text-gray-700 dark:text-gray-300 m-0">
      {JSON.stringify(v, null, 2)}
    </pre>
  );
}

function CopyableBlock({ content, preformatted }: { content: string; preformatted?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard not available — quietly no-op rather than throwing a toast
      // (the content is right there for manual selection).
    }
  };

  return (
    <div className="relative">
      <button
        onClick={copy}
        aria-label="Copy"
        className="absolute top-2 right-2 inline-flex items-center gap-1 px-1.5 py-0.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
      >
        {copied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      {preformatted ? (
        <pre className="text-xs font-mono text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-3 pr-16 whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
          {content}
        </pre>
      ) : (
        <div className="text-xs text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-3 pr-16 break-all">
          {content}
        </div>
      )}
    </div>
  );
}

// ----- helpers (shared with the table's column renderers) --------------------

function getMessage(entry: LogEntry): string {
  const p = entry.parsed as Record<string, unknown> | undefined;
  if (p && typeof p.message === 'string') return p.message;
  if (p && typeof p.raw === 'string') return p.raw;
  return entry.line;
}

function pickService(entry: LogEntry): string {
  return (
    (entry.parsed?.service as string)
    || entry.labels?.service_name
    || entry.labels?.service
    || ''
  );
}

function pickLevel(entry: LogEntry): string {
  return (entry.parsed?.level as string) || entry.labels?.level || '';
}
