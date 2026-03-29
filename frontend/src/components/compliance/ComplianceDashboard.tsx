'use client';

import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { Shield, CheckCircle, AlertTriangle, XCircle, Activity, Clock, BookOpen, ShieldOff, Scan, Sparkles, FileText, Filter } from 'lucide-react';
import api from '@/lib/api';
import { Pagination, type PaginationState } from '@/components/ui/Pagination';
import type { ComplianceAuditEntry, ComplianceRule } from '@/types/compliance';

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

type Tab = 'overview' | 'rules' | 'policies' | 'subscriptions' | 'enforced' | 'exemptions' | 'scans' | 'schedules' | 'templates';

const TABS: { id: Tab; label: string; icon: typeof Shield }[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'rules', label: 'Rules', icon: Shield },
  { id: 'policies', label: 'Policies', icon: FileText },
  { id: 'subscriptions', label: 'Catalog', icon: BookOpen },
  { id: 'enforced', label: 'Enforced', icon: CheckCircle },
  { id: 'exemptions', label: 'Exemptions', icon: ShieldOff },
  { id: 'scans', label: 'Scans', icon: Scan },
  { id: 'schedules', label: 'Schedules', icon: Clock },
  { id: 'templates', label: 'Templates', icon: Sparkles },
];

const STAT_COLORS: Record<string, string> = {
  blue: 'text-blue-600 bg-blue-50 dark:bg-blue-900/20',
  green: 'text-green-600 bg-green-50 dark:bg-green-900/20',
  yellow: 'text-yellow-600 bg-yellow-50 dark:bg-yellow-900/20',
  red: 'text-red-600 bg-red-50 dark:bg-red-900/20',
};

const RESULT_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pass: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400', label: 'Pass' },
  warn: { bg: 'bg-yellow-100 dark:bg-yellow-900/30', text: 'text-yellow-700 dark:text-yellow-400', label: 'Warn' },
  block: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400', label: 'Block' },
};

function TabSpinner() {
  return <div className="flex justify-center py-12"><div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" /></div>;
}

interface ComplianceDashboardProps {
  isAdmin?: boolean;
}

export default function ComplianceDashboard({ isAdmin = false }: ComplianceDashboardProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const [audit, setAudit] = useState<ComplianceAuditEntry[]>([]);
  const [stats, setStats] = useState({ rules: 0, pass: 0, warn: 0, block: 0 });

  // Sub-views for drill-downs
  const [historyRule, setHistoryRule] = useState<{ id: string; name: string } | null>(null);
  const [detailScanId, setDetailScanId] = useState<string | null>(null);
  const [editorRule, setEditorRule] = useState<ComplianceRule | undefined>(undefined);
  const [showEditor, setShowEditor] = useState(false);

  // Audit log filters & pagination
  const [auditTarget, setAuditTarget] = useState('');
  const [auditResult, setAuditResult] = useState('');
  const [auditPagination, setAuditPagination] = useState<PaginationState>({ limit: 20, offset: 0, total: 0 });

  const fetchAudit = useCallback(async (offset = auditPagination.offset, limit = auditPagination.limit) => {
    try {
      const params: Record<string, string | number> = { limit, offset };
      if (auditTarget) params.target = auditTarget;
      if (auditResult) params.result = auditResult;
      const res = await api.getComplianceAuditLog(params);
      if (res.success && res.data) {
        setAudit(res.data.entries);
        if (res.data.pagination) {
          setAuditPagination({ limit: res.data.pagination.limit, offset: res.data.pagination.offset, total: res.data.pagination.total });
          // Update stats from total counts (first page load only)
          if (offset === 0) {
            const entries = res.data.entries;
            setStats(s => ({
              ...s,
              pass: entries.filter(e => e.result === 'pass').length,
              warn: entries.filter(e => e.result === 'warn').length,
              block: entries.filter(e => e.result === 'block').length,
            }));
          }
        }
      }
    } catch { /* handled by API layer */ }
  }, [auditTarget, auditResult, auditPagination.offset, auditPagination.limit]);

  useEffect(() => {
    fetchAudit();
    api.getComplianceRules({ limit: 1 }).then(res => {
      if (res.success && res.data?.pagination) {
        setStats(s => ({ ...s, rules: res.data!.pagination!.total }));
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset to page 1 when filters change
  useEffect(() => {
    setAuditPagination(prev => ({ ...prev, offset: 0 }));
  }, [auditTarget, auditResult]);

  // Refetch audit when filters change (skip initial since above handles it)
  const filtersActive = auditTarget || auditResult;
  useEffect(() => {
    if (filtersActive) fetchAudit();
  }, [filtersActive, fetchAudit]);

  const handleAuditPageChange = (offset: number) => { fetchAudit(offset, auditPagination.limit); };
  const handleAuditPageSizeChange = (limit: number) => { fetchAudit(0, limit); };

  // Clear sub-views on tab change
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

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <nav className="flex gap-1 border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
              tab === id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <Suspense fallback={<TabSpinner />}>
        {tab === 'overview' && (
          <Overview
            stats={stats}
            audit={audit}
            auditTarget={auditTarget}
            auditResult={auditResult}
            onTargetChange={setAuditTarget}
            onResultChange={setAuditResult}
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
                  onEdit={isAdmin ? handleEditRule : undefined}
                  onCreateNew={isAdmin ? handleCreateRule : undefined}
                />
        )}
        {tab === 'policies' && <PolicyManager readOnly={!isAdmin} />}
        {tab === 'subscriptions' && <SubscriptionManager readOnly={!isAdmin} />}
        {tab === 'enforced' && <EnforcedRulesView />}
        {tab === 'exemptions' && <ExemptionManager readOnly={!isAdmin} />}
        {tab === 'scans' && (
          detailScanId
            ? <ScanDetail scanId={detailScanId} onBack={() => setDetailScanId(null)} />
            : <ScanManager onViewScan={handleViewScan} readOnly={!isAdmin} />
        )}
        {tab === 'schedules' && <ScanScheduleManager readOnly={!isAdmin} />}
        {tab === 'templates' && <TemplateOnboarding />}
      </Suspense>
    </div>
  );
}

interface OverviewProps {
  stats: { rules: number; pass: number; warn: number; block: number };
  audit: ComplianceAuditEntry[];
  auditTarget: string;
  auditResult: string;
  onTargetChange: (v: string) => void;
  onResultChange: (v: string) => void;
  auditPagination: PaginationState;
  onAuditPageChange: (offset: number) => void;
  onAuditPageSizeChange: (limit: number) => void;
}

function Overview({ stats, audit, auditTarget, auditResult, onTargetChange, onResultChange, auditPagination, onAuditPageChange, onAuditPageSizeChange }: OverviewProps) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {([
          { icon: Shield, label: 'Active Rules', value: stats.rules, color: 'blue' },
          { icon: CheckCircle, label: 'Passed', value: stats.pass, color: 'green' },
          { icon: AlertTriangle, label: 'Warnings', value: stats.warn, color: 'yellow' },
          { icon: XCircle, label: 'Blocked', value: stats.block, color: 'red' },
        ] as const).map(({ icon: Icon, label, value, color }) => (
          <div key={label} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
            <div className="flex items-center gap-3">
              <div className={`rounded-lg p-2 ${STAT_COLORS[color]}`}><Icon className="h-5 w-5" /></div>
              <div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Activity className="h-4 w-4" /> Recent Checks
          </h3>
          <div className="flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-gray-400" />
            <select
              value={auditTarget}
              onChange={e => onTargetChange(e.target.value)}
              className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs"
            >
              <option value="">All targets</option>
              <option value="plugin">Plugin</option>
              <option value="pipeline">Pipeline</option>
            </select>
            <select
              value={auditResult}
              onChange={e => onResultChange(e.target.value)}
              className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs"
            >
              <option value="">All results</option>
              <option value="pass">Pass</option>
              <option value="warn">Warn</option>
              <option value="block">Block</option>
            </select>
          </div>
        </div>
        {audit.length === 0 ? (
          <div className="text-center py-4 text-sm text-gray-400">No audit entries found.</div>
        ) : (
          <>
            <div className="space-y-1">
              {audit.map(entry => {
                const r = RESULT_STYLES[entry.result] || RESULT_STYLES.pass;
                return (
                  <div key={entry.id} className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-800 last:border-0">
                    <div className="flex items-center gap-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${r.bg} ${r.text}`}>{r.label}</span>
                      <span className="text-sm text-gray-900 dark:text-white">{entry.entityName || entry.entityId || 'Unknown'}</span>
                      <span className="text-xs text-gray-400">({entry.target})</span>
                    </div>
                    <span className="flex items-center gap-1 text-xs text-gray-400">
                      <Clock className="h-3 w-3" /> {new Date(entry.createdAt).toLocaleString()}
                    </span>
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
