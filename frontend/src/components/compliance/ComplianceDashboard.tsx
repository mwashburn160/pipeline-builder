'use client';

import { useState, useEffect, lazy, Suspense } from 'react';
import Link from 'next/link';
import { Shield, ShieldCheck, CheckCircle, AlertTriangle, XCircle, Activity, Clock, BookOpen, ShieldOff, Scan, Sparkles, FileText, Filter, Bell, ChevronDown, History, SlidersHorizontal } from 'lucide-react';
import api from '@/lib/api';
import { Pagination } from '@/components/ui/Pagination';
import { StatusPill } from '@/components/ui/StatusPill';
import { Button } from '@/components/ui/Button';
import { TabBar } from '@/components/ui/TabBar';
import { LoadingSpinner } from '@/components/ui/Loading';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { PostureHeadline } from '@/components/ui/PostureHeadline';
import { formatRelativeTime } from '@/lib/relative-time';
import type { ComplianceAuditEntry, ComplianceRule } from '@/types/compliance';
import { formatDateTime } from '@/lib/format';
import { useUrlTab } from '@/hooks/useUrlTab';
import { ComplianceOverview } from './ComplianceOverview';

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
// the top level stays scannable and related panels live together. The section is
// derived from the active tab (`?view=` stays the one source of truth), and a
// sub-tab row shows only for a section with more than one member.
type Section = 'overview' | 'definitions' | 'scanning' | 'settings';
const SECTIONS: { id: Section; label: string; icon: typeof Shield; tabs: Tab[] }[] = [
  { id: 'overview', label: 'Overview', icon: Activity, tabs: ['overview'] },
  { id: 'definitions', label: 'Rules & policies', icon: Shield, tabs: ['rules', 'policies', 'subscriptions', 'enforced', 'templates'] },
  { id: 'scanning', label: 'Scanning', icon: Scan, tabs: ['scans', 'schedules'] },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal, tabs: ['exemptions', 'notifications'] },
];

function TabSpinner() {
  return <div className="flex justify-center py-12"><LoadingSpinner label="Loading view" /></div>;
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
    void Promise.all([fetchCount('pass'), fetchCount('warn'), fetchCount('block')]).then(
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
          <ComplianceOverview stats={stats} onGoToRules={() => setTab('rules')} />
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
