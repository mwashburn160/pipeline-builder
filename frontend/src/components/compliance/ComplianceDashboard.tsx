'use client';

import { useState, useEffect, lazy, Suspense } from 'react';
import Link from 'next/link';
import { Shield, ShieldCheck, CheckCircle, AlertTriangle, XCircle, Activity, Clock, BookOpen, ShieldOff, Scan, Sparkles, FileText, Filter, Bell, ChevronDown, History, SlidersHorizontal } from 'lucide-react';
import api from '@/lib/api';
import { Pagination } from '@/components/ui/Pagination';
import { StatusPill } from '@/components/ui/StatusPill';
import { Button } from '@/components/ui/Button';
import { TabBar } from '@/components/ui/TabBar';
import { RetryError } from '@/components/ui/RetryError';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { PostureHeadline } from '@/components/ui/PostureHeadline';
import { formatRelativeTime } from '@/lib/relative-time';
import type { ComplianceAuditEntry, ComplianceRule } from '@/types/compliance';
import { RESULT_STYLES } from '@/lib/compliance-styles';
import { formatDateTime } from '@/lib/format';
import { useUrlTab } from '@/hooks/useUrlTab';
import { useComplianceAudit } from './useComplianceAudit';

const RuleList = lazy(() => import('./RuleList'));
const RuleEditor = lazy(() => import('./RuleEditor'));
const SubscriptionManager = lazy(() => import('./SubscriptionManager'));
const ComplianceContentSets = lazy(() => import('./ComplianceContentSets'));
const ExemptionManager = lazy(() => import('./ExemptionManager'));
const ScanManager = lazy(() => import('./ScanManager'));
const TemplateOnboarding = lazy(() => import('./TemplateOnboarding'));
const EnforcedRulesView = lazy(() => import('./EnforcedRulesView'));
const PolicyManager = lazy(() => import('./PolicyManager'));
const RuleHistory = lazy(() => import('./RuleHistory'));
const ScanDetail = lazy(() => import('./ScanDetail'));
const ScanScheduleManager = lazy(() => import('./ScanScheduleManager'));
const NotificationPreferencesManager = lazy(() => import('./NotificationPreferencesManager'));

const COMPLIANCE_TABS = ['overview', 'rules', 'policies', 'subscriptions', 'enforced', 'exemptions', 'scans', 'schedules', 'templates', 'notifications'] as const;
type Tab = (typeof COMPLIANCE_TABS)[number];

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

function TabSpinner() {
  return <div className="flex justify-center py-12"><div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" /></div>;
}

interface ComplianceDashboardProps {
  canManage?: boolean;
}

export default function ComplianceDashboard({ canManage = false }: ComplianceDashboardProps) {
  // Tab lives in the URL: compliance has 10 views across 2 levels, and none of
  // them could be linked, bookmarked or returned to with browser Back.
  const [tab, setTab] = useUrlTab<Tab>('view', COMPLIANCE_TABS, 'overview');
  const [stats, setStats] = useState({ rules: 0, pass: 0, warn: 0, block: 0 });

  // Sub-views for drill-downs
  const [historyRule, setHistoryRule] = useState<{ id: string; name: string } | null>(null);
  const [detailScanId, setDetailScanId] = useState<string | null>(null);
  const [editorRule, setEditorRule] = useState<ComplianceRule | undefined>(undefined);
  const [showEditor, setShowEditor] = useState(false);

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
      {/* Level 1 — top-level sections (4, not a flat run of 10 tabs). Selecting a
          section opens its first view; the view itself lives in `?view=`. */}
      <TabBar
        items={SECTIONS.map(({ id, label, icon: Icon }) => ({
          id,
          label: <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><Icon className="h-4 w-4" /> {label}</span>,
        }))}
        activeId={activeSection.id}
        onSelect={(id) => {
          const section = SECTIONS.find((s) => s.id === id);
          if (section && section.id !== activeSection.id) setTab(section.tabs[0]);
        }}
        ariaLabel="Compliance sections"
        className="!mb-0"
      />

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
                    ? 'bg-info-bg text-info'
                    : 'text-fg-muted hover:bg-surface-muted'
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
          <Overview stats={stats} onGoToRules={() => setTab('rules')} />
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
        {tab === 'subscriptions' && (
          <div className="space-y-6">
            {/* Curated content sets — entitlement-gated (upsell for unheld sets). The
                catalog below is the actual browse/subscribe surface. */}
            <ComplianceContentSets />
            <SubscriptionManager readOnly={!canManage} />
          </div>
        )}
        {tab === 'enforced' && <EnforcedRulesView />}
        {tab === 'exemptions' && <ExemptionManager readOnly={!canManage} />}
        {tab === 'scans' && (
          detailScanId
            ? <ScanDetail scanId={detailScanId} onBack={() => setDetailScanId(null)} readOnly={!canManage} />
            : <ScanManager onViewScan={handleViewScan} readOnly={!canManage} />
        )}
        {tab === 'schedules' && <ScanScheduleManager readOnly={!canManage} />}
        {tab === 'templates' && <TemplateOnboarding readOnly={!canManage} />}
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
  if (error) return <RetryError message={error} onRetry={onRetry} />;
  if (changes === null) return <TabSpinner />;
  if (changes.length === 0) {
    return <div className="text-center py-6 text-sm text-fg-subtle">No compliance changes recorded yet.</div>;
  }
  return (
    <ul className="divide-y divide-default">
      {changes.map(e => {
        const r = RESULT_STYLES[e.result] || RESULT_STYLES.pass;
        const violations = Array.isArray(e.violations) ? e.violations : [];
        return (
          <li key={e.id} className="py-2 flex items-baseline justify-between gap-2 text-sm">
            <div className="min-w-0 flex items-baseline gap-2">
              <StatusPill className={`${r.bg} ${r.text}`}>{r.label}</StatusPill>
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
  stats: { rules: number; pass: number; warn: number; block: number };
  onGoToRules: () => void;
}

function Overview({ stats, onGoToRules }: OverviewProps) {
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
    { key: 'rules', icon: Shield, label: 'Active rules', value: stats.rules, color: 'blue', result: null as string | null, onClick: onGoToRules },
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
                      isActive ? 'bg-brand text-white' : 'bg-surface text-fg-muted hover:bg-surface-muted'
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
                const r = RESULT_STYLES[entry.result] || RESULT_STYLES.pass;
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
                        <StatusPill className={`${r.bg} ${r.text}`}>{r.label}</StatusPill>
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
