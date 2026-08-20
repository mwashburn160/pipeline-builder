'use client';

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import Link from 'next/link';
import { Shield, ShieldCheck, CheckCircle, AlertTriangle, XCircle, Activity, Clock, BookOpen, ShieldOff, Scan, Sparkles, FileText, Filter, Bell, ChevronDown, History, SlidersHorizontal } from 'lucide-react';
import api from '@/lib/api';
import { Pagination, type PaginationState } from '@/components/ui/Pagination';
import { StatusPill } from '@/components/ui/StatusPill';
import { TabBar } from '@/components/ui/TabBar';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { PostureHeadline } from '@/components/ui/PostureHeadline';
import { formatRelativeTime } from '@/lib/relative-time';
import type { ComplianceAuditEntry, ComplianceRule } from '@/types/compliance';
import { RESULT_STYLES } from '@/lib/compliance-styles';

const RuleList = lazy(() => import('./RuleList'));
const RuleEditor = lazy(() => import('./RuleEditor'));
const SubscriptionManager = lazy(() => import('./SubscriptionManager'));
const ExemptionManager = lazy(() => import('./ExemptionManager'));
const ScanManager = lazy(() => import('./ScanManager'));
const TemplateOnboarding = lazy(() => import('./TemplateOnboarding'));
const EnforcedRulesView = lazy(() => import('./EnforcedRulesView'));
const PolicyManager = lazy(() => import('./PolicyManager'));
const RuleHistory = lazy(() => import('./RuleHistory'));
const ScanDetail = lazy(() => import('./ScanDetail'));
const ScanScheduleManager = lazy(() => import('./ScanScheduleManager'));
const NotificationPreferencesManager = lazy(() => import('./NotificationPreferencesManager'));

type Tab = 'overview' | 'rules' | 'policies' | 'subscriptions' | 'enforced' | 'exemptions' | 'scans' | 'schedules' | 'templates' | 'notifications';

const TAB_META: Record<Tab, { label: string; icon: typeof Shield }> = {
  overview: { label: 'Overview', icon: Activity },
  rules: { label: 'Rules', icon: Shield },
  policies: { label: 'Policies', icon: FileText },
  subscriptions: { label: 'Catalog', icon: BookOpen },
  enforced: { label: 'Enforced', icon: CheckCircle },
  exemptions: { label: 'Exemptions', icon: ShieldOff },
  scans: { label: 'Scans', icon: Scan },
  schedules: { label: 'Schedules', icon: Clock },
  templates: { label: 'Templates', icon: Sparkles },
  notifications: { label: 'Notifications', icon: Bell },
};

// Two-level navigation: 4 top-level SECTIONS instead of a flat run of 10 tabs, so
// the top level stays scannable and related panels live together. The `tab` state
// model is UNCHANGED — each sub-tab still `setTab(id)`; the section is just derived
// from the active tab, and a sub-tab row shows only for a section with >1 member.
type Section = 'overview' | 'definitions' | 'scanning' | 'settings';
const SECTIONS: { id: Section; label: string; icon: typeof Shield; tabs: Tab[] }[] = [
  { id: 'overview', label: 'Overview', icon: Activity, tabs: ['overview'] },
  { id: 'definitions', label: 'Rules & policies', icon: Shield, tabs: ['rules', 'policies', 'subscriptions', 'enforced', 'templates'] },
  { id: 'scanning', label: 'Scanning', icon: Scan, tabs: ['scans', 'schedules'] },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal, tabs: ['exemptions', 'notifications'] },
];

const STAT_COLORS: Record<string, string> = {
  blue: 'text-blue-600 bg-blue-50 dark:bg-blue-900/20',
  green: 'text-green-600 bg-green-50 dark:bg-green-900/20',
  yellow: 'text-yellow-600 bg-yellow-50 dark:bg-yellow-900/20',
  red: 'text-red-600 bg-red-50 dark:bg-red-900/20',
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

function TabSpinner() {
  return <div className="flex justify-center py-12"><div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" /></div>;
}

interface ComplianceDashboardProps {
  canManage?: boolean;
}

export default function ComplianceDashboard({ canManage = false }: ComplianceDashboardProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const [audit, setAudit] = useState<ComplianceAuditEntry[]>([]);
  // A failed audit fetch was previously swallowed (`catch {}`), leaving stale/empty
  // entries that read as "no audit entries". Track the error so the Overview can
  // show a retry banner instead.
  const [auditError, setAuditError] = useState<string | null>(null);
  const [stats, setStats] = useState({ rules: 0, pass: 0, warn: 0, block: 0 });

  // Sub-views for drill-downs
  const [historyRule, setHistoryRule] = useState<{ id: string; name: string } | null>(null);
  const [detailScanId, setDetailScanId] = useState<string | null>(null);
  const [editorRule, setEditorRule] = useState<ComplianceRule | undefined>(undefined);
  const [showEditor, setShowEditor] = useState(false);

  // Audit log filters & pagination
  const [auditTarget, setAuditTarget] = useState('');
  const [auditResult, setAuditResult] = useState('');
  // Date-range scope (empty = unbounded). `getComplianceAuditLog` accepts
  // dateFrom/dateTo; the result filter already exists as a select above.
  const [auditDateFrom, setAuditDateFrom] = useState('');
  const [auditDateTo, setAuditDateTo] = useState('');
  const [auditPagination, setAuditPagination] = useState<PaginationState>({ limit: 20, offset: 0, total: 0 });

  // Monotonic guard: driven by four filters + pagination + retry, an older
  // in-flight response could otherwise resolve last and overwrite the current
  // filter's rows. Bail on any setState if a newer fetch has started since.
  const auditGenRef = useRef(0);
  const fetchAudit = useCallback(async (offset = auditPagination.offset, limit = auditPagination.limit) => {
    const gen = ++auditGenRef.current;
    try {
      const params: Record<string, string | number> = { limit, offset };
      if (auditTarget) params.target = auditTarget;
      if (auditResult) params.result = auditResult;
      if (auditDateFrom) params.dateFrom = auditDateFrom;
      if (auditDateTo) params.dateTo = auditDateTo;
      const res = await api.getComplianceAuditLog(params);
      if (auditGenRef.current !== gen) return; // superseded by a newer fetch
      if (res.success && res.data) {
        setAudit(res.data.entries);
        setAuditError(null);
        if (res.data.pagination) {
          setAuditPagination({ limit: res.data.pagination.limit, offset: res.data.pagination.offset, total: res.data.pagination.total });
        }
      } else {
        setAuditError(res.message || 'Failed to load audit log');
      }
    } catch {
      if (auditGenRef.current === gen) setAuditError('Failed to load audit log');
    }
  }, [auditTarget, auditResult, auditDateFrom, auditDateTo, auditPagination.offset, auditPagination.limit]);

  // Pass/warn/block counts come from dedicated `result=` queries that ask
  // for `limit:1` and read `pagination.total`. We can't derive the totals
  // from `entries.filter(...).length` because that's only the current page.
  useEffect(() => {
    let cancelled = false;
    const fetchCount = (result: 'pass' | 'warn' | 'block') =>
      api.getComplianceAuditLog({ result, limit: 1 })
        .then((res) => (res.success && res.data?.pagination?.total) || 0)
        .catch(() => 0);
    Promise.all([fetchCount('pass'), fetchCount('warn'), fetchCount('block')]).then(
      ([pass, warn, block]) => {
        if (cancelled) return;
        setStats((s) => ({ ...s, pass, warn, block }));
      },
    );
    api.getComplianceRules({ limit: 1 }).then(res => {
      if (cancelled) return;
      if (res.success && res.data?.pagination) {
        setStats(s => ({ ...s, rules: res.data!.pagination!.total }));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Reset to page 1 when filters change.
  useEffect(() => {
    setAuditPagination(prev => ({ ...prev, offset: 0 }));
  }, [auditTarget, auditResult, auditDateFrom, auditDateTo]);

  // Refetch the audit log when the filters change. The previous
  // `filtersActive` truthy-string indirection skipped fetches when both
  // filters were cleared at once; this fires on any transition.
  useEffect(() => {
    // Pass offset 0 explicitly: the reset-offset effect above runs in the same
    // commit, so `auditPagination.offset` is still the previous page's value in
    // this closure. Without the explicit 0, changing a filter while on page 2+
    // would refetch the old offset and render an empty page.
    fetchAudit(0);
    // fetchAudit closes over the same deps; we want to fire only when the
    // user-facing filters change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditTarget, auditResult, auditDateFrom, auditDateTo]);

  const handleAuditPageChange = (offset: number) => { fetchAudit(offset, auditPagination.limit); };
  const handleAuditPageSizeChange = (limit: number) => { fetchAudit(0, limit); };

  // Clear sub-views on tab change. NOTE (N37): the RuleHistory view is
  // intentionally only reachable through this gate (rules tab + a selected
  // history rule). Tab navigation resets the gate so the user always lands
  // on the list view, not a stale drill-down.
  useEffect(() => {
    setHistoryRule(null);
    setDetailScanId(null);
    setShowEditor(false);
    setEditorRule(undefined);
  }, [tab]);

  const handleViewHistory = (rule: ComplianceRule) => {
    setHistoryRule({ id: rule.id, name: rule.name });
  };

  const handleViewScan = (scanId: string) => {
    setDetailScanId(scanId);
  };

  const handleEditRule = (rule: ComplianceRule) => {
    setEditorRule(rule);
    setShowEditor(true);
  };

  const handleCreateRule = () => {
    setEditorRule(undefined);
    setShowEditor(true);
  };

  const handleRuleSaved = () => {
    setShowEditor(false);
    setEditorRule(undefined);
  };

  // Derive the active top-level section from the current tab, and the sub-tabs to
  // offer beneath it. Overview has no sub-tabs (its section holds only itself).
  const activeSection = SECTIONS.find(s => s.tabs.includes(tab)) ?? SECTIONS[0];
  const subTabs = activeSection.tabs.length > 1 ? activeSection.tabs : [];

  return (
    <div className="space-y-4">
      {/* Level 1 — top-level sections (4, not a flat run of 10 tabs). */}
      <nav className="flex items-center gap-1 border-b border-gray-200 dark:border-gray-700 overflow-x-auto" aria-label="Compliance sections">
        {SECTIONS.map(({ id, label, icon: Icon, tabs }) => {
          const active = activeSection.id === id;
          return (
            <button
              key={id}
              onClick={() => { if (!active) setTab(tabs[0]); }}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                active ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          );
        })}
      </nav>

      {/* Level 2 — sub-tabs for the active section (hidden for Overview). */}
      {subTabs.length > 0 && (
        <nav className="flex items-center gap-1 flex-wrap" aria-label={`${activeSection.label} views`}>
          {subTabs.map((id) => {
            const { label, icon: Icon } = TAB_META[id];
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                  active
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                    : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                }`}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            );
          })}
        </nav>
      )}

      {/* Content */}
      <Suspense fallback={<TabSpinner />}>
        {tab === 'overview' && (
          <Overview
            stats={stats}
            audit={audit}
            auditError={auditError}
            onRetryAudit={() => fetchAudit()}
            auditTarget={auditTarget}
            auditResult={auditResult}
            onTargetChange={setAuditTarget}
            onResultChange={setAuditResult}
            onGoToRules={() => setTab('rules')}
            auditDateFrom={auditDateFrom}
            auditDateTo={auditDateTo}
            onDateFromChange={setAuditDateFrom}
            onDateToChange={setAuditDateTo}
            auditPagination={auditPagination}
            onAuditPageChange={handleAuditPageChange}
            onAuditPageSizeChange={handleAuditPageSizeChange}
          />
        )}
        {tab === 'rules' && (
          showEditor
            ? <RuleEditor rule={editorRule} onSave={handleRuleSaved} onCancel={() => setShowEditor(false)} />
            : historyRule
              ? <RuleHistory ruleId={historyRule.id} ruleName={historyRule.name} onBack={() => setHistoryRule(null)} />
              : <RuleList
                  onViewHistory={handleViewHistory}
                  onEdit={canManage ? handleEditRule : undefined}
                  onCreateNew={canManage ? handleCreateRule : undefined}
                />
        )}
        {tab === 'policies' && <PolicyManager readOnly={!canManage} />}
        {tab === 'subscriptions' && <SubscriptionManager readOnly={!canManage} />}
        {tab === 'enforced' && <EnforcedRulesView />}
        {tab === 'exemptions' && <ExemptionManager readOnly={!canManage} />}
        {tab === 'scans' && (
          detailScanId
            ? <ScanDetail scanId={detailScanId} onBack={() => setDetailScanId(null)} />
            : <ScanManager onViewScan={handleViewScan} readOnly={!canManage} />
        )}
        {tab === 'schedules' && <ScanScheduleManager readOnly={!canManage} />}
        {tab === 'templates' && <TemplateOnboarding />}
        {tab === 'notifications' && <NotificationPreferencesManager readOnly={!canManage} />}
      </Suspense>
    </div>
  );
}

/**
 * Compact, action-oriented "Recent changes" feed — the second tab of the Overview
 * activity panel. Reads the same compliance audit trail as "Recent check results"
 * but leads with the action verb (create/update/delete) and stays unfiltered/most-
 * recent, so it answers "what changed lately?" at a glance. `changes === null` = loading.
 */
function ChangesFeed({ changes, error, onRetry }: { changes: ComplianceAuditEntry[] | null; error: string | null; onRetry: () => void }) {
  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-2 text-sm text-red-700 dark:text-red-300">
        <span>{error}</span>
        <button onClick={onRetry} className="underline hover:no-underline shrink-0">Retry</button>
      </div>
    );
  }
  if (changes === null) return <TabSpinner />;
  if (changes.length === 0) {
    return <div className="text-center py-6 text-sm text-gray-400">No compliance changes recorded yet.</div>;
  }
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
      {changes.map(e => {
        const r = RESULT_STYLES[e.result] || RESULT_STYLES.pass;
        const violations = Array.isArray(e.violations) ? e.violations : [];
        return (
          <li key={e.id} className="py-2 flex items-baseline justify-between gap-2 text-sm">
            <div className="min-w-0 flex items-baseline gap-2">
              <StatusPill className={`${r.bg} ${r.text}`}>{r.label}</StatusPill>
              <span className="text-gray-800 dark:text-gray-200 truncate">
                <code className="text-xs">{e.action}</code>
                {e.entityName && <span className="text-gray-500 dark:text-gray-400"> on {e.entityName}</span>}
              </span>
              {violations.length > 0 && (
                <span className="text-xs text-red-500 dark:text-red-400 shrink-0">{violations.length} violation{violations.length === 1 ? '' : 's'}</span>
              )}
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatRelativeTime(e.createdAt)}</span>
          </li>
        );
      })}
    </ul>
  );
}

interface OverviewProps {
  stats: { rules: number; pass: number; warn: number; block: number };
  audit: ComplianceAuditEntry[];
  auditError: string | null;
  onRetryAudit: () => void;
  auditTarget: string;
  auditResult: string;
  onTargetChange: (v: string) => void;
  onResultChange: (v: string) => void;
  onGoToRules: () => void;
  auditDateFrom: string;
  auditDateTo: string;
  onDateFromChange: (v: string) => void;
  onDateToChange: (v: string) => void;
  auditPagination: PaginationState;
  onAuditPageChange: (offset: number) => void;
  onAuditPageSizeChange: (limit: number) => void;
}

function Overview({ stats, audit, auditError, onRetryAudit, auditTarget, auditResult, onTargetChange, onResultChange, onGoToRules, auditDateFrom, auditDateTo, onDateFromChange, onDateToChange, auditPagination, onAuditPageChange, onAuditPageSizeChange }: OverviewProps) {
  // Inline drill-in: which row is expanded to show its violations/metadata.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Activity panel tabs: the rich, filterable "Recent check results" feed and a
  // compact, action-oriented "Recent changes" list (create/update/delete). Both
  // read the compliance audit trail; changes are fetched lazily the first time
  // that tab is opened (unfiltered, most-recent) so the default view costs nothing.
  const [activityTab, setActivityTab] = useState<'checks' | 'changes'>('checks');
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
      .catch(() => { if (!cancelled) setChangesError('Failed to load recent changes'); });
    return () => { cancelled = true; };
  }, [activityTab, changes]);
  const totalChecks = stats.pass + stats.warn + stats.block;
  const passRate = totalChecks > 0 ? Math.round((stats.pass / totalChecks) * 100) : 100;

  // Posture: the single "are we compliant?" headline — worst signal wins.
  const posture = stats.block > 0
    ? { tone: 'red' as const, icon: XCircle, title: `${stats.block} blocked`, detail: `${stats.warn} warning${stats.warn === 1 ? '' : 's'} · ${passRate}% passing` }
    : stats.warn > 0
      ? { tone: 'yellow' as const, icon: AlertTriangle, title: `${stats.warn} warning${stats.warn === 1 ? '' : 's'}`, detail: `No blocks · ${passRate}% passing` }
      : totalChecks > 0
        ? { tone: 'green' as const, icon: ShieldCheck, title: 'All clear', detail: `All ${stats.pass} check${stats.pass === 1 ? '' : 's'} passing` }
        : { tone: 'gray' as const, icon: Shield, title: 'No checks yet', detail: 'Compliance check results will appear here' };

  // Stat cards double as filters: results toggle the log filter, rules jumps tabs.
  const statCards = [
    { key: 'rules', icon: Shield, label: 'Active Rules', value: stats.rules, color: 'blue', result: null as string | null, onClick: onGoToRules },
    { key: 'pass', icon: CheckCircle, label: 'Passed', value: stats.pass, color: 'green', result: 'pass', onClick: () => onResultChange(auditResult === 'pass' ? '' : 'pass') },
    { key: 'warn', icon: AlertTriangle, label: 'Warnings', value: stats.warn, color: 'yellow', result: 'warn', onClick: () => onResultChange(auditResult === 'warn' ? '' : 'warn') },
    { key: 'block', icon: XCircle, label: 'Blocked', value: stats.block, color: 'red', result: 'block', onClick: () => onResultChange(auditResult === 'block' ? '' : 'block') },
  ];

  // Date-range presets — nobody wants to type two dates for "this week".
  const presets: { label: string; days: number | null }[] = [
    { label: '24h', days: 1 },
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: 'All', days: null },
  ];
  const applyPreset = (days: number | null) => {
    if (days === null) { onDateFromChange(''); onDateToChange(''); return; }
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    onDateFromChange(from.toISOString().slice(0, 10));
    onDateToChange(to.toISOString().slice(0, 10));
  };
  const allDatesActive = !auditDateFrom && !auditDateTo;
  const filtersActive = Boolean(auditResult || auditTarget || auditDateFrom || auditDateTo);

  return (
    <div className="space-y-6">
      {/* Posture headline — answers "are we compliant?" at a glance */}
      <PostureHeadline
        tone={posture.tone}
        Icon={posture.icon}
        title={posture.title}
        detail={posture.detail}
        rate={totalChecks > 0 ? passRate : undefined}
      />

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
              className={`text-left rounded-lg border bg-white dark:bg-gray-900 p-4 shadow-sm transition hover:border-gray-300 hover:shadow dark:hover:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                active ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200 dark:border-gray-700'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`rounded-lg p-2 ${STAT_COLORS[color]}`}><Icon className="h-5 w-5" /></div>
                <div>
                  <div className="text-2xl font-bold text-gray-900 dark:text-white tabular-nums">{value}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3 pb-3 border-b border-gray-100 dark:border-gray-800 gap-2 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <TabBar
              items={[{ id: 'checks', label: 'Recent check results' }, { id: 'changes', label: 'Recent changes' }]}
              activeId={activityTab}
              onSelect={(id) => setActivityTab(id as 'checks' | 'changes')}
            />
            {activityTab === 'checks' && auditResult && (
              <button onClick={() => onResultChange('')} className="text-xs font-normal text-blue-600 hover:underline">
                {auditResult} only · clear
              </button>
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
            <Filter className="h-3.5 w-3.5 text-gray-400" />
            <FilterSelect
              value={auditTarget}
              onChange={e => onTargetChange(e.target.value)}
              aria-label="Filter audit log by target"
            >
              <option value="">All targets</option>
              <option value="plugin">Plugin</option>
              <option value="pipeline">Pipeline</option>
            </FilterSelect>
            <FilterSelect
              value={auditResult}
              onChange={e => onResultChange(e.target.value)}
              aria-label="Filter audit log by result"
            >
              <option value="">All results</option>
              <option value="pass">Pass</option>
              <option value="warn">Warn</option>
              <option value="block">Block</option>
            </FilterSelect>
            {/* Date range: quick presets + custom inputs (empty = unbounded). */}
            <div className="inline-flex rounded border border-gray-300 dark:border-gray-600 overflow-hidden">
              {presets.map(p => {
                const isActive = p.days === null && allDatesActive;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => applyPreset(p.days)}
                    className={`px-2 py-1 text-xs border-l first:border-l-0 border-gray-300 dark:border-gray-600 ${
                      isActive ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
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
              className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs tabular-nums"
              title="From date"
              aria-label="Audit log from date"
            />
            <span className="text-xs text-gray-400">→</span>
            <input
              type="date"
              value={auditDateTo}
              onChange={e => onDateToChange(e.target.value)}
              className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs tabular-nums"
              title="To date"
              aria-label="Audit log to date"
            />
          </div>
          )}
        </div>
        {activityTab === 'changes' ? (
          <ChangesFeed changes={changes} error={changesError} onRetry={() => { setChanges(null); setChangesError(null); }} />
        ) : auditError ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-2 text-sm text-red-700 dark:text-red-300">
            <span>{auditError}</span>
            <button onClick={onRetryAudit} className="underline hover:no-underline shrink-0">Retry</button>
          </div>
        ) : audit.length === 0 ? (
          <div className="text-center py-6 text-sm text-gray-400">
            {filtersActive ? 'No checks match these filters.' : 'No check results recorded yet.'}
          </div>
        ) : (
          <>
            <div className="space-y-0.5">
              {audit.map(entry => {
                const r = RESULT_STYLES[entry.result] || RESULT_STYLES.pass;
                const expanded = expandedId === entry.id;
                const violations = Array.isArray(entry.violations) ? entry.violations : [];
                return (
                  <div key={entry.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : entry.id)}
                      aria-expanded={expanded}
                      className="w-full flex items-center justify-between gap-3 py-2 px-2 -mx-2 rounded text-left hover:bg-gray-50 dark:hover:bg-gray-800/50"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <ChevronDown className={`h-3.5 w-3.5 text-gray-400 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`} />
                        <StatusPill className={`${r.bg} ${r.text}`}>{r.label}</StatusPill>
                        <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 shrink-0">{entry.action}</span>
                        <span className="text-sm text-gray-900 dark:text-white truncate">{entry.entityName || entry.entityId || 'Unknown'}</span>
                        <span className="text-[11px] uppercase tracking-wide text-gray-400 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 shrink-0">{entry.target}</span>
                        {violations.length > 0 && (
                          <span className="text-[11px] text-red-500 dark:text-red-400 shrink-0">{violations.length} violation{violations.length === 1 ? '' : 's'}</span>
                        )}
                      </div>
                      <span
                        className="flex items-center gap-1 text-xs text-gray-400 shrink-0"
                        title={new Date(entry.createdAt).toLocaleString()}
                      >
                        <Clock className="h-3 w-3" /> {formatRelativeTime(entry.createdAt)}
                      </span>
                    </button>
                    {expanded && (
                      <div className="ml-5 mb-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-3 text-xs space-y-2">
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-gray-500 dark:text-gray-400">
                          <span><span className="font-medium text-gray-700 dark:text-gray-300">Action:</span> <code>{entry.action}</code></span>
                          <span><span className="font-medium text-gray-700 dark:text-gray-300">Rules evaluated:</span> {entry.ruleCount}</span>
                          <span title={new Date(entry.createdAt).toLocaleString()}><span className="font-medium text-gray-700 dark:text-gray-300">When:</span> {new Date(entry.createdAt).toLocaleString()}</span>
                          {entry.entityId && <span><span className="font-medium text-gray-700 dark:text-gray-300">Entity ID:</span> <code className="break-all">{entry.entityId}</code></span>}
                          {entry.scanId && <span><span className="font-medium text-gray-700 dark:text-gray-300">Scan:</span> <code className="break-all">{entry.scanId}</code></span>}
                        </div>
                        {violations.length > 0 ? (
                          <div className="space-y-1.5">
                            <div className="font-medium text-gray-700 dark:text-gray-300">{violations.length} violation{violations.length === 1 ? '' : 's'}</div>
                            {violations.map((raw, i) => {
                              const v = readViolation(raw);
                              return (
                                <div key={i} className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium text-gray-900 dark:text-white">{v.ruleName}</span>
                                    {v.severity && <span className="text-[10px] uppercase tracking-wide text-gray-400 border border-gray-200 dark:border-gray-700 rounded px-1 py-0.5">{v.severity}</span>}
                                  </div>
                                  {v.message && <div className="text-gray-600 dark:text-gray-400 mt-0.5">{v.message}</div>}
                                  {(v.field || v.operator) && (
                                    <div className="text-gray-500 dark:text-gray-500 mt-1">
                                      <code>{v.field}</code> {v.operator} — expected <code className="text-gray-700 dark:text-gray-300">{fmtVal(v.expectedValue)}</code>, got <code className="text-red-600 dark:text-red-400">{fmtVal(v.actualValue)}</code>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="text-gray-500 dark:text-gray-400">No violations — all {entry.ruleCount} rule{entry.ruleCount === 1 ? '' : 's'} passed.</div>
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
