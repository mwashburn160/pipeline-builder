'use client';

import { useState, useEffect, useCallback } from 'react';
import { Shield, Loader2 } from 'lucide-react';
import api from '@/lib/api';
import type { ComplianceRule, RuleTarget } from '@/types/compliance';
import { SEVERITY_BADGE as SEVERITY_COLORS } from '@/lib/compliance-styles';

export default function EnforcedRulesView() {
  const [rules, setRules] = useState<ComplianceRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [targetFilter, setTargetFilter] = useState<RuleTarget | ''>('');

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (targetFilter) params.target = targetFilter;
      const res = await api.getEnforcedRules(params);
      if (res.success && res.data) setRules(res.data.rules);
    } catch { /* handled by loading state */ }
    setLoading(false);
  }, [targetFilter]);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  const orgRules = rules.filter(r => r.scope === 'org');
  const subscribedRules = rules.filter(r => r.scope === 'published');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-green-600" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">All Enforced Rules ({rules.length})</h2>
        </div>
        <select
          value={targetFilter}
          onChange={(e) => setTargetFilter(e.target.value as RuleTarget | '')}
          className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
        >
          <option value="">All targets</option>
          <option value="plugin">Plugin</option>
          <option value="pipeline">Pipeline</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-green-600" /></div>
      ) : rules.length === 0 ? (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">No rules are currently enforced. Create org rules or activate subscribed rules.</div>
      ) : (
        <div className="space-y-6">
          {orgRules.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Org Rules ({orgRules.length})</h3>
              <RuleTable rules={orgRules} />
            </div>
          )}
          {subscribedRules.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Subscribed Rules ({subscribedRules.length})</h3>
              <RuleTable rules={subscribedRules} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RuleTable({ rules }: { rules: ComplianceRule[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Target</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Severity</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Field</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Priority</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
          {rules.map(rule => (
            <tr key={rule.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
              <td className="px-4 py-2.5">
                <div className="text-sm font-medium text-gray-900 dark:text-white">{rule.name}</div>
                {rule.description && <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-xs">{rule.description}</div>}
              </td>
              <td className="px-4 py-2.5">
                <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-full px-2 py-0.5">{rule.target}</span>
              </td>
              <td className="px-4 py-2.5">
                <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${SEVERITY_COLORS[rule.severity] || SEVERITY_COLORS.warning}`}>{rule.severity}</span>
              </td>
              <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400 font-mono">
                {rule.field || (rule.conditions ? `${rule.conditions.length} conditions` : '-')}
              </td>
              <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400">{rule.priority}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
