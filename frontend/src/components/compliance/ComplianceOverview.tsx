'use client';

import { localDaysBack } from '@/lib/local-day';
import { Badge } from '@/components/ui/Badge';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Shield, ShieldCheck, CheckCircle, AlertTriangle, XCircle, Clock, Filter, ChevronDown, History } from 'lucide-react';
import api from '@/lib/api';
import { Pagination } from '@/components/ui/Pagination';
import { StatusPill } from '@/components/ui/StatusPill';
import { Button } from '@/components/ui/Button';
import { TabBar } from '@/components/ui/TabBar';
import { RetryError } from '@/components/ui/RetryError';
import { LoadingSpinner } from '@/components/ui/Loading';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { PostureHeadline } from '@/components/ui/PostureHeadline';
import { formatRelativeTime } from '@/lib/relative-time';
import type { ComplianceAuditEntry } from '@/types/compliance';
import { RULE_TARGET_IDS, RULE_TARGET_LABELS, COMPLIANCE_RESULT_IDS, RESULT_STYLES, resultStyle } from '@/lib/compliance-styles';
import { formatDateTime } from '@/lib/format';
import { useUrlTab } from '@/hooks/useUrlTab';
import { useFetch } from '@/hooks/useFetch';
import { formatError } from '@/lib/constants';
import { useComplianceAudit } from './useComplianceAudit';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * The compliance Overview tab: the posture headline, the four clickable stat
 * cards, and the activity panel (the filterable check log + the recent-changes
 * feed). Split out of the dashboard shell, which only routes between tabs.
 */

const STAT_COLORS: Record<string, string> = {
  blue: 'text-info bg-info-bg',
  green: 'text-success bg-success-bg',
  yellow: 'text-warning bg-warning-bg',
  red: 'text-danger bg-danger-bg',
};

// Render a violation's expected/actual value (may be object/array/null) compactly.
function fmtVal(x: unknown): string {
  if (x === null || x === undefined) return '∅';
  if (typeof x === 'object') { try { return JSON.stringify(x); } catch { return String(x); } }
  return String(x);
}

// A row's `violations` are loosely typed (Record<string, unknown>[]); read the
// fields we display defensively so a shape drift can't crash the drill-in.
function readViolation(raw: Record<string, unknown>) {
  return {
    ruleName: String(raw.ruleName ?? raw.ruleId ?? 'Rule'),
    field: raw.field != null ? String(raw.field) : '',
    operator: raw.operator != null ? String(raw.operator) : '',
    severity: raw.severity != null ? String(raw.severity) : '',
    message: raw.message != null ? String(raw.message) : '',
    expectedValue: raw.expectedValue,
    actualValue: raw.actualValue,
  };
}

const ACTIVITY_TABS = [
  { id: 'checks', label: 'Recent check results' },
  { id: 'changes', label: 'Recent changes' },
] as const;
type ActivityTab = (typeof ACTIVITY_TABS)[number]['id'];
const ACTIVITY_TAB_IDS: readonly ActivityTab[] = ACTIVITY_TABS.map((t) => t.id);

/**
 * The `action` values the compliance check log records: the validate routes
 * (`upload` for plugins, `create` for pipelines), scans, and the entity-event
 * re-checks fired on create/update/delete.
 */
const AUDIT_ACTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All actions' },
  { value: 'upload', label: 'Plugin upload' },
  { value: 'create', label: 'Pipeline create' },
  { value: 'scan', label: 'Scan' },
  { value: 'created', label: 'Entity created' },
  { value: 'updated', label: 'Entity updated' },
  { value: 'deleted', label: 'Entity deleted' },
];



/**
 * Compact, action-oriented "Recent changes" feed — the second tab of the Overview
 * activity panel. Reads the same compliance audit trail as "Recent check results"
 * but leads with the action verb (create/update/delete) and stays unfiltered/most-
 * recent, so it answers "what changed lately?" at a glance. `changes === null` = loading.
 */
function ChangesFeed({ changes, error, onRetry }: { changes: ComplianceAuditEntry[] | null; error: string | null; onRetry: () => void }) {
  if (error) return <RetryError message={error} onRetry={onRetry} />;
  if (changes === null) return <div className="flex justify-center py-12"><LoadingSpinner label="Loading recent changes" /></div>;
  if (changes.length === 0) {
    return <EmptyState compact title="No compliance changes recorded yet" />;
  }
  return (
    <ul className="divide-y divide-default">
      {changes.map(e => {
        const r = resultStyle(e.result);
        const violations = Array.isArray(e.violations) ? e.violations : [];
        return (
          <li key={e.id} className="py-2 flex items-baseline justify-between gap-2 text-sm">
            <div className="min-w-0 flex items-baseline gap-2">
              <Badge color={r.color}>{r.label}</Badge>
              <span className="text-fg truncate">
                <code className="text-xs">{e.action}</code>
                {e.entityName && <span className="text-fg-muted"> on {e.entityName}</span>}
              </span>
              {violations.length > 0 && (
                <span className="text-xs text-danger shrink-0">{violations.length} violation{violations.length === 1 ? '' : 's'}</span>
              )}
            </div>
            <span className="text-xs text-fg-muted whitespace-nowrap">{formatRelativeTime(e.createdAt)}</span>
          </li>
        );
      })}
    </ul>
  );
}

interface OverviewProps {
  onGoToRules: () => void;
}

/** One `result=` count: `limit:1` and read `pagination.total` (a page's
 *  `entries.length` is only that page). A failed read THROWS — a 0 here would
 *  be a claim ("nothing blocked") the server never made. */
async function auditCount(result: 'pass' | 'warn' | 'block', signal: AbortSignal): Promise<number> {
  const res = await api.getComplianceAuditLog({ result, limit: 1 }, { signal });
  const total = res.success ? res.data?.pagination?.total : undefined;
  if (typeof total !== 'number') throw new Error(res.message || `Could not count ${result} checks`);
  return total;
}

export function ComplianceOverview({ onGoToRules }: OverviewProps) {
  // The posture counts. Read here, so they re-read each time the Overview opens
  // (it unmounts on a tab switch) — after a scan, rule edit or exemption made on
  // another tab, the numbers are current rather than the page-load totals.
  // All three or none: the posture is the worst of them, and computing it from a
  // partial set turned a failed `block` read into a green "All clear".
  const checksQ = useFetch(async (signal) => {
    const [pass, warn, block] = await Promise.all([
      auditCount('pass', signal), auditCount('warn', signal), auditCount('block', signal),
    ]);
    return { pass, warn, block };
  }, []);
  const rulesQ = useFetch(async (signal) => {
    const res = await api.getComplianceRules({ limit: 1 }, { signal });
    const total = res.success ? res.data?.pagination?.total : undefined;
    if (typeof total !== 'number') throw new Error(res.message || 'Could not count the rules');
    return total;
  }, []);
  const checks = checksQ.data;
  // The check log's filters/pagination/fetch — state the Overview alone reads,
  // so it lives here rather than being drilled down from the dashboard shell.
  const {
    entries: audit,
    error: auditError,
    filters: { target: auditTarget, result: auditResult, action: auditAction, dateFrom: auditDateFrom, dateTo: auditDateTo },
    setTarget: onTargetChange,
    setResult: onResultChange,
    setAction: onActionChange,
    setDateFrom: onDateFromChange,
    setDateTo: onDateToChange,
    filtersActive,
    pagination: auditPagination,
    handlePageChange: onAuditPageChange,
    handlePageSizeChange: onAuditPageSizeChange,
    retry: onRetryAudit,
  } = useComplianceAudit();

  // Inline drill-in: which row is expanded to show its violations/metadata.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Activity panel tabs: the rich, filterable "Recent check results" feed and a
  // compact, action-oriented "Recent changes" list (create/update/delete). Both
  // read the compliance audit trail; changes are fetched lazily the first time
  // that tab is opened (unfiltered, most-recent) so the default view costs nothing.
  // In `?activity=` like the dashboard's own view, so "Recent changes" is linkable.
  const [activityTab, setActivityTab] = useUrlTab<ActivityTab>('activity', ACTIVITY_TAB_IDS, 'checks');
  const [changes, setChanges] = useState<ComplianceAuditEntry[] | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  useEffect(() => {
    if (activityTab !== 'changes' || changes !== null) return;
    let cancelled = false;
    setChangesError(null);
    api.getComplianceAuditLog({ limit: 10 })
      .then(res => {
        if (cancelled) return;
        if (res.success && res.data) setChanges(res.data.entries);
        else setChangesError(res.message || 'Failed to load recent changes');
      })
      .catch((err) => { if (!cancelled) setChangesError(formatError(err, 'Failed to load recent changes')); });
    return () => { cancelled = true; };
  }, [activityTab, changes]);
  const totalChecks = checks ? checks.pass + checks.warn + checks.block : 0;
  const passRate = checks && totalChecks > 0 ? Math.round((checks.pass / totalChecks) * 100) : 100;

  // Posture: the single "are we compliant?" headline — worst signal wins. Only
  // computed from a complete set of counts; until then it says so.
  const posture = !checks
    ? checksQ.error
      ? { tone: 'gray' as const, icon: Shield, title: 'Posture unavailable', detail: 'The check counts could not be loaded' }
      : { tone: 'gray' as const, icon: Shield, title: 'Loading posture…', detail: 'Counting check results' }
    : checks.block > 0
      ? { tone: 'red' as const, icon: XCircle, title: `${checks.block} blocked`, detail: `${checks.warn} warning${checks.warn === 1 ? '' : 's'} · ${passRate}% passing` }
      : checks.warn > 0
        ? { tone: 'yellow' as const, icon: AlertTriangle, title: `${checks.warn} warning${checks.warn === 1 ? '' : 's'}`, detail: `No blocks · ${passRate}% passing` }
        : totalChecks > 0
          ? { tone: 'green' as const, icon: ShieldCheck, title: 'All clear', detail: `All ${checks.pass} check${checks.pass === 1 ? '' : 's'} passing` }
          : { tone: 'gray' as const, icon: Shield, title: 'No checks yet', detail: 'Compliance check results will appear here' };

  // Stat cards double as filters: results toggle the log filter, rules jumps tabs.
  // An unread count shows a dash, never a 0.
  const shown = (n: number | null | undefined) => (typeof n === 'number' ? n : '—');
  const statCards = [
    { key: 'rules', icon: Shield, label: 'Active rules', value: shown(rulesQ.data), color: 'blue', result: null as string | null, onClick: onGoToRules },
    { key: 'pass', icon: CheckCircle, label: 'Passed', value: shown(checks?.pass), color: 'green', result: 'pass', onClick: () => onResultChange(auditResult === 'pass' ? '' : 'pass') },
    { key: 'warn', icon: AlertTriangle, label: 'Warnings', value: shown(checks?.warn), color: 'yellow', result: 'warn', onClick: () => onResultChange(auditResult === 'warn' ? '' : 'warn') },
    { key: 'block', icon: XCircle, label: 'Blocked', value: shown(checks?.block), color: 'red', result: 'block', onClick: () => onResultChange(auditResult === 'block' ? '' : 'block') },
  ];
  const countsError = checksQ.error ?? rulesQ.error;
  const retryCounts = () => { void checksQ.refetch(); void rulesQ.refetch(); };

  // Date-range presets — nobody wants to type two dates for "this week".
  const presets: { label: string; days: number | null }[] = [
    { label: '24h', days: 1 },
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: 'All', days: null },
  ];
  const applyPreset = (days: number | null) => {
    if (days === null) { onDateFromChange(''); onDateToChange(''); return; }
    // Local days, matching the date inputs (the UTC day is tomorrow in the
    // evening west of UTC).
    const range = localDaysBack(days);
    onDateFromChange(range.from);
    onDateToChange(range.to);
  };
  const allDatesActive = !auditDateFrom && !auditDateTo;

  return (
    <div className="space-y-6">
      {/* Posture headline — answers "are we compliant?" at a glance */}
      <PostureHeadline
        tone={posture.tone}
        Icon={posture.icon}
        title={posture.title}
        detail={posture.detail}
        rate={checks && totalChecks > 0 ? passRate : undefined}
      />
      {countsError && (
        <RetryError message={formatError(countsError, 'Could not load the compliance counts')} onRetry={retryCounts} />
      )}

      {/* Stat cards — clickable: results filter the log below, rules opens the tab */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map(({ key, icon: Icon, label, value, color, result, onClick }) => {
          const active = result != null && auditResult === result;
          return (
            <button
              key={key}
              type="button"
              onClick={onClick}
              aria-pressed={result != null ? active : undefined}
              title={result != null ? (active ? 'Clear filter' : `Show ${label.toLowerCase()} checks`) : 'View rules'}
              className={`text-left rounded-lg border bg-surface p-4 shadow-sm transition hover:shadow focus:outline-none focus:ring-2 focus:ring-brand ${
                active ? 'border-brand ring-1 ring-brand' : 'border-default'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`rounded-lg p-2 ${STAT_COLORS[color]}`}><Icon className="h-5 w-5" /></div>
                <div>
                  <div className="text-2xl font-bold text-fg tabular-nums">{value}</div>
                  <div className="text-xs text-fg-muted">{label}</div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="rounded-lg border border-default bg-surface p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3 pb-3 border-b border-default gap-2 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <TabBar
              items={ACTIVITY_TABS}
              activeId={activityTab}
              onSelect={(id) => setActivityTab(id as ActivityTab)}
              ariaLabel="Compliance activity"
            />
            {activityTab === 'checks' && auditResult && (
              <Button variant="link" onClick={() => onResultChange('')} className="text-xs font-normal">
                {auditResult} only · clear
              </Button>
            )}
            <Link
              href="/dashboard/audit?action=compliance"
              className="action-link text-xs inline-flex items-center gap-1"
            >
              <History className="h-3.5 w-3.5" /> Full audit log →
            </Link>
          </div>
          {activityTab === 'checks' && (
          <div className="flex flex-wrap items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-fg-subtle" />
            <FilterSelect
              value={auditTarget}
              onChange={e => onTargetChange(e.target.value)}
              aria-label="Filter audit log by target"
            >
              <option value="">All targets</option>
              {RULE_TARGET_IDS.map((t) => <option key={t} value={t}>{RULE_TARGET_LABELS[t]}</option>)}
            </FilterSelect>
            <FilterSelect
              value={auditResult}
              onChange={e => onResultChange(e.target.value)}
              aria-label="Filter audit log by result"
            >
              <option value="">All results</option>
              {COMPLIANCE_RESULT_IDS.map((r) => <option key={r} value={r}>{RESULT_STYLES[r].label}</option>)}
            </FilterSelect>
            <FilterSelect
              value={auditAction}
              onChange={e => onActionChange(e.target.value)}
              aria-label="Filter audit log by action"
            >
              {AUDIT_ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </FilterSelect>
            {/* Date range: quick presets + custom inputs (empty = unbounded). */}
            <div className="inline-flex rounded border border-default overflow-hidden">
              {presets.map(p => {
                const isActive = p.days === null && allDatesActive;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => applyPreset(p.days)}
                    className={`px-2 py-1 text-xs border-l first:border-l-0 border-default ${
                      isActive ? 'bg-brand-solid text-white' : 'bg-surface text-fg-muted hover:bg-surface-muted'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <input
              type="date"
              value={auditDateFrom}
              onChange={e => onDateFromChange(e.target.value)}
              className="rounded border border-default bg-surface px-2 py-1 text-xs tabular-nums"
              title="From date"
              aria-label="Audit log from date"
            />
            <span className="text-xs text-fg-subtle">→</span>
            <input
              type="date"
              value={auditDateTo}
              onChange={e => onDateToChange(e.target.value)}
              className="rounded border border-default bg-surface px-2 py-1 text-xs tabular-nums"
              title="To date"
              aria-label="Audit log to date"
            />
          </div>
          )}
        </div>
        {activityTab === 'changes' ? (
          <ChangesFeed changes={changes} error={changesError} onRetry={() => { setChanges(null); setChangesError(null); }} />
        ) : auditError ? (
          <RetryError message={auditError} onRetry={onRetryAudit} />
        ) : audit.length === 0 ? (
          <div className="text-center py-6 text-sm text-fg-subtle">
            {filtersActive ? 'No checks match these filters.' : 'No check results recorded yet.'}
          </div>
        ) : (
          <>
            <div className="space-y-0.5">
              {audit.map(entry => {
                const r = resultStyle(entry.result);
                const expanded = expandedId === entry.id;
                const violations = Array.isArray(entry.violations) ? entry.violations : [];
                return (
                  <div key={entry.id} className="border-b border-default last:border-0">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : entry.id)}
                      aria-expanded={expanded}
                      className="w-full flex items-center justify-between gap-3 py-2 px-2 -mx-2 rounded text-left hover:bg-surface-muted"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <ChevronDown className={`h-3.5 w-3.5 text-fg-subtle shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`} />
                        <Badge color={r.color}>{r.label}</Badge>
                        <span className="text-2xs font-medium text-fg-subtle shrink-0">{entry.action}</span>
                        <span className="text-sm text-fg truncate">{entry.entityName || entry.entityId || 'Unknown'}</span>
                        <span className="text-2xs uppercase tracking-wide text-fg-subtle border border-default rounded px-1.5 py-0.5 shrink-0">{entry.target}</span>
                        {violations.length > 0 && (
                          <span className="text-2xs text-danger shrink-0">{violations.length} violation{violations.length === 1 ? '' : 's'}</span>
                        )}
                      </div>
                      <span
                        className="flex items-center gap-1 text-xs text-fg-subtle shrink-0"
                        title={formatDateTime(entry.createdAt)}
                      >
                        <Clock className="h-3 w-3" /> {formatRelativeTime(entry.createdAt)}
                      </span>
                    </button>
                    {expanded && (
                      <div className="ml-5 mb-2 rounded-lg border border-default bg-surface-muted p-3 text-xs space-y-2">
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-fg-muted">
                          <span><span className="font-medium text-fg-muted">Action:</span> <code>{entry.action}</code></span>
                          <span><span className="font-medium text-fg-muted">Rules evaluated:</span> {entry.ruleCount}</span>
                          <span title={formatDateTime(entry.createdAt)}><span className="font-medium text-fg-muted">When:</span> {formatDateTime(entry.createdAt)}</span>
                          {entry.entityId && <span><span className="font-medium text-fg-muted">Entity ID:</span> <code className="break-all">{entry.entityId}</code></span>}
                          {entry.scanId && <span><span className="font-medium text-fg-muted">Scan:</span> <code className="break-all">{entry.scanId}</code></span>}
                        </div>
                        {violations.length > 0 ? (
                          <div className="space-y-1.5">
                            <div className="font-medium text-fg-muted">{violations.length} violation{violations.length === 1 ? '' : 's'}</div>
                            {violations.map((raw, i) => {
                              const v = readViolation(raw);
                              return (
                                <div key={i} className="rounded border border-default bg-surface p-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium text-fg">{v.ruleName}</span>
                                    {v.severity && <span className="text-2xs uppercase tracking-wide text-fg-subtle border border-default rounded px-1 py-0.5">{v.severity}</span>}
                                  </div>
                                  {v.message && <div className="text-fg-muted mt-0.5">{v.message}</div>}
                                  {(v.field || v.operator) && (
                                    <div className="text-fg-subtle mt-1">
                                      <code>{v.field}</code> {v.operator} — expected <code className="text-fg-muted">{fmtVal(v.expectedValue)}</code>, got <code className="text-danger">{fmtVal(v.actualValue)}</code>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="text-fg-muted">No violations — all {entry.ruleCount} rule{entry.ruleCount === 1 ? '' : 's'} passed.</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {auditPagination.total > auditPagination.limit && (
              <Pagination
                pagination={auditPagination}
                onPageChange={onAuditPageChange}
                onPageSizeChange={onAuditPageSizeChange}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
