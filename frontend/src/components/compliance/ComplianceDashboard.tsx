'use client';

import { useState, useEffect } from 'react';
import { Shield, CheckCircle, AlertTriangle, XCircle, Activity, Clock } from 'lucide-react';
import api from '@/lib/api';
import RuleList from './RuleList';
import type { ComplianceRule, ComplianceAuditEntry } from '@/types/compliance';

export default function ComplianceDashboard() {
  const [recentAudit, setRecentAudit] = useState<ComplianceAuditEntry[]>([]);
  const [stats, setStats] = useState({ rules: 0, pass: 0, warn: 0, block: 0 });
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingRule, setEditingRule] = useState<ComplianceRule | null>(null);

  useEffect(() => {
    // Fetch recent audit entries for the stats
    api.getComplianceAuditLog({ limit: 50 }).then((res) => {
      if (res.success && res.data) {
        const entries = res.data.entries as ComplianceAuditEntry[];
        setRecentAudit(entries.slice(0, 10));
        setStats({
          rules: 0, // Will be set by RuleList
          pass: entries.filter((e) => e.result === 'pass').length,
          warn: entries.filter((e) => e.result === 'warn').length,
          block: entries.filter((e) => e.result === 'block').length,
        });
      }
    }).catch(() => {});

    api.getComplianceRules({ limit: 1 }).then((res) => {
      if (res.success && res.data?.pagination) {
        setStats((s) => ({ ...s, rules: res.data!.pagination!.total }));
      }
    }).catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          icon={Shield}
          label="Active Rules"
          value={stats.rules}
          color="blue"
        />
        <StatCard
          icon={CheckCircle}
          label="Checks Passed"
          value={stats.pass}
          color="green"
        />
        <StatCard
          icon={AlertTriangle}
          label="Warnings"
          value={stats.warn}
          color="yellow"
        />
        <StatCard
          icon={XCircle}
          label="Blocked"
          value={stats.block}
          color="red"
        />
      </div>

      {/* Recent Violations */}
      {recentAudit.length > 0 && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Recent Compliance Checks
          </h3>
          <div className="space-y-2">
            {recentAudit.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-800 last:border-0">
                <div className="flex items-center gap-3">
                  <ResultBadge result={entry.result} />
                  <div>
                    <span className="text-sm text-gray-900 dark:text-white">{entry.entityName || entry.entityId || 'Unknown'}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">({entry.target} / {entry.action})</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 text-xs text-gray-400">
                  <Clock className="h-3 w-3" />
                  {new Date(entry.createdAt).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rule List */}
      <RuleList
        onEdit={setEditingRule}
        onCreateNew={() => setShowCreateForm(true)}
      />
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: { icon: typeof Shield; label: string; value: number; color: string }) {
  const colorClasses: Record<string, string> = {
    blue: 'text-blue-600 bg-blue-50 dark:bg-blue-900/20',
    green: 'text-green-600 bg-green-50 dark:bg-green-900/20',
    yellow: 'text-yellow-600 bg-yellow-50 dark:bg-yellow-900/20',
    red: 'text-red-600 bg-red-50 dark:bg-red-900/20',
  };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
      <div className="flex items-center gap-3">
        <div className={`rounded-lg p-2 ${colorClasses[color]}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
        </div>
      </div>
    </div>
  );
}

function ResultBadge({ result }: { result: string }) {
  const config: Record<string, { bg: string; text: string; label: string }> = {
    pass: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400', label: 'Pass' },
    warn: { bg: 'bg-yellow-100 dark:bg-yellow-900/30', text: 'text-yellow-700 dark:text-yellow-400', label: 'Warn' },
    block: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400', label: 'Block' },
  };
  const c = config[result] || config.pass;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${c.bg} ${c.text}`}>
      {c.label}
    </span>
  );
}
