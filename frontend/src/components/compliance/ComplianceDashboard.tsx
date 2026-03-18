'use client';

import { useState, useEffect, lazy, Suspense } from 'react';
import { Shield, CheckCircle, AlertTriangle, XCircle, Activity, Clock, BookOpen, ShieldOff, Scan, Sparkles } from 'lucide-react';
import api from '@/lib/api';
import type { ComplianceAuditEntry } from '@/types/compliance';

const RuleList = lazy(() => import('./RuleList'));
const SubscriptionManager = lazy(() => import('./SubscriptionManager'));
const ExemptionManager = lazy(() => import('./ExemptionManager'));
const ScanManager = lazy(() => import('./ScanManager'));
const TemplateOnboarding = lazy(() => import('./TemplateOnboarding'));
const EnforcedRulesView = lazy(() => import('./EnforcedRulesView'));

type Tab = 'overview' | 'rules' | 'subscriptions' | 'enforced' | 'exemptions' | 'scans' | 'templates';

const TABS: { id: Tab; label: string; icon: typeof Shield }[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'rules', label: 'Rules', icon: Shield },
  { id: 'subscriptions', label: 'Catalog', icon: BookOpen },
  { id: 'enforced', label: 'Enforced', icon: CheckCircle },
  { id: 'exemptions', label: 'Exemptions', icon: ShieldOff },
  { id: 'scans', label: 'Scans', icon: Scan },
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

export default function ComplianceDashboard() {
  const [tab, setTab] = useState<Tab>('overview');
  const [audit, setAudit] = useState<ComplianceAuditEntry[]>([]);
  const [stats, setStats] = useState({ rules: 0, pass: 0, warn: 0, block: 0 });

  useEffect(() => {
    Promise.allSettled([
      api.getComplianceAuditLog({ limit: 50 }),
      api.getComplianceRules({ limit: 1 }),
    ]).then(([auditRes, rulesRes]) => {
      if (auditRes.status === 'fulfilled' && auditRes.value.success && auditRes.value.data) {
        const entries = auditRes.value.data.entries;
        setAudit(entries.slice(0, 10));
        setStats(s => ({
          ...s,
          pass: entries.filter(e => e.result === 'pass').length,
          warn: entries.filter(e => e.result === 'warn').length,
          block: entries.filter(e => e.result === 'block').length,
        }));
      }
      if (rulesRes.status === 'fulfilled' && rulesRes.value.success && rulesRes.value.data?.pagination) {
        setStats(s => ({ ...s, rules: rulesRes.value.data!.pagination!.total }));
      }
    });
  }, []);

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
        {tab === 'overview' && <Overview stats={stats} audit={audit} />}
        {tab === 'rules' && <RuleList />}
        {tab === 'subscriptions' && <SubscriptionManager />}
        {tab === 'enforced' && <EnforcedRulesView />}
        {tab === 'exemptions' && <ExemptionManager />}
        {tab === 'scans' && <ScanManager />}
        {tab === 'templates' && <TemplateOnboarding />}
      </Suspense>
    </div>
  );
}

function Overview({ stats, audit }: { stats: { rules: number; pass: number; warn: number; block: number }; audit: ComplianceAuditEntry[] }) {
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

      {audit.length > 0 && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
            <Activity className="h-4 w-4" /> Recent Checks
          </h3>
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
        </div>
      )}
    </div>
  );
}
