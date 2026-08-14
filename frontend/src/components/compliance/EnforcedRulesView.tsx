'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Shield, Loader2 } from 'lucide-react';
import { TextEmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterSelect } from '@/components/ui/FilterSelect';
import api from '@/lib/api';
import type { ComplianceRule, RuleTarget } from '@/types/compliance';
import { SEVERITY_BADGE as SEVERITY_COLORS } from '@/lib/compliance-styles';

export default function EnforcedRulesView() {
  const [rules, setRules] = useState<ComplianceRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [targetFilter, setTargetFilter] = useState<RuleTarget | ''>('');

  // Stale-response guard: a rapid target-filter switch (or unmount) must not
  // let an older in-flight response overwrite the current filter's rules.
  const genRef = useRef(0);

  const fetchRules = useCallback(async () => {
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {};
      if (targetFilter) params.target = targetFilter;
      const res = await api.getEnforcedRules(params);
      if (gen !== genRef.current) return;
      if (res.success && res.data) setRules(res.data.rules);
      else setError(res.message || 'Failed to load enforced rules');
    } catch {
      if (gen !== genRef.current) return;
      setError('Failed to load enforced rules');
    }
    if (gen === genRef.current) setLoading(false);
  }, [targetFilter]);

  useEffect(() => {
    fetchRules();
    return () => { genRef.current++; };
  }, [fetchRules]);

  const orgRules = rules.filter(r => r.scope === 'org');
  const subscribedRules = rules.filter(r => r.scope === 'published');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-green-600" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">All Enforced Rules ({rules.length})</h2>
        </div>
        <FilterSelect
          value={targetFilter}
          onChange={(e) => setTargetFilter(e.target.value as RuleTarget | '')}
          aria-label="Filter enforced rules by target"
        >
          <option value="">All targets</option>
          <option value="plugin">Plugin</option>
          <option value="pipeline">Pipeline</option>
        </FilterSelect>
      </div>

      {error && !loading && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-2 text-sm text-red-700 dark:text-red-300">
          <span>{error}</span>
          <button onClick={fetchRules} className="underline hover:no-underline">Retry</button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-green-600" /></div>
      ) : rules.length === 0 ? (
        <TextEmptyState>No rules are currently enforced. Create org rules or activate subscribed rules.</TextEmptyState>
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

const ENFORCED_RULE_COLUMNS: Column<ComplianceRule>[] = [
  {
    id: 'name',
    header: 'Name',
    render: (rule) => (
      <>
        <div className="text-sm font-medium text-gray-900 dark:text-white">{rule.name}</div>
        {rule.description && <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-xs">{rule.description}</div>}
      </>
    ),
  },
  {
    id: 'target',
    header: 'Target',
    render: (rule) => <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-full px-2 py-0.5">{rule.target}</span>,
  },
  {
    id: 'severity',
    header: 'Severity',
    render: (rule) => <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${SEVERITY_COLORS[rule.severity] || SEVERITY_COLORS.warning}`}>{rule.severity}</span>,
  },
  {
    id: 'field',
    header: 'Field',
    cellClassName: 'text-sm text-gray-600 dark:text-gray-400 font-mono',
    render: (rule) => rule.field || (rule.conditions ? `${rule.conditions.length} conditions` : '-'),
  },
  {
    id: 'priority',
    header: 'Priority',
    cellClassName: 'text-sm text-gray-600 dark:text-gray-400',
    render: (rule) => rule.priority,
  },
];

function RuleTable({ rules }: { rules: ComplianceRule[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <DataTable
        data={rules}
        columns={ENFORCED_RULE_COLUMNS}
        isLoading={false}
        getRowKey={(rule) => rule.id}
        emptyState={{ icon: Shield, title: 'No rules', description: 'No enforced rules in this scope.' }}
      />
    </div>
  );
}
