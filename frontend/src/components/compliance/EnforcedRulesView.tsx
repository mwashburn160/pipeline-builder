'use client';

import { useState } from 'react';
import { Shield } from 'lucide-react';
import { TextEmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { RetryError } from '@/components/ui/RetryError';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import type { ComplianceRule, RuleTarget } from '@/types/compliance';
import { SEVERITY_BADGE as SEVERITY_COLORS } from '@/lib/compliance-styles';
import { InheritedBadge } from './InheritedBadge';
import { LoadingSpinner } from '@/components/ui/Loading';
import { StatusPill } from '@/components/ui/StatusPill';

export default function EnforcedRulesView() {
  const [targetFilter, setTargetFilter] = useState<RuleTarget | ''>('');

  // A filter switch supersedes the in-flight read, so an older response can't
  // overwrite the current filter's rules.
  const { data, loading, error, refetch } = useFetch<ComplianceRule[]>(async () => {
    const params: Record<string, string> = {};
    if (targetFilter) params.target = targetFilter;
    let res: Awaited<ReturnType<typeof api.getEnforcedRules>>;
    try {
      res = await api.getEnforcedRules(params);
    } catch {
      throw new Error('Failed to load enforced rules');
    }
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load enforced rules');
    return res.data.rules;
  }, [targetFilter]);
  const rules = data ?? [];

  const orgRules = rules.filter(r => r.scope === 'org');
  const subscribedRules = rules.filter(r => r.scope === 'published');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-success" />
          <h2 className="text-lg font-semibold text-fg">All enforced rules ({rules.length})</h2>
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

      {error && !loading && <RetryError message={error.message} onRetry={() => void refetch()} />}

      {loading ? (
        <div className="flex items-center justify-center py-12"><LoadingSpinner label="Loading enforced rules" /></div>
      ) : rules.length === 0 ? (
        <TextEmptyState>No rules are currently enforced. Create org rules or activate subscribed rules.</TextEmptyState>
      ) : (
        <div className="space-y-6">
          {orgRules.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-fg-muted mb-2">Org rules ({orgRules.length})</h3>
              <RuleTable rules={orgRules} />
            </div>
          )}
          {subscribedRules.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-fg-muted mb-2">Subscribed rules ({subscribedRules.length})</h3>
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
        <div className="text-sm font-medium text-fg">{rule.name}</div>
        {rule.description && <div className="text-xs text-fg-muted truncate max-w-xs">{rule.description}</div>}
        {rule.inherited && <div className="mt-1"><InheritedBadge rule={rule} withReason /></div>}
      </>
    ),
  },
  {
    id: 'target',
    header: 'Target',
    render: (rule) => <StatusPill className="bg-surface-muted text-fg-muted">{rule.target}</StatusPill>,
  },
  {
    id: 'severity',
    header: 'Severity',
    render: (rule) => <StatusPill className={SEVERITY_COLORS[rule.severity] || SEVERITY_COLORS.warning}>{rule.severity}</StatusPill>,
  },
  {
    id: 'field',
    header: 'Field',
    cellClassName: 'text-sm text-fg-muted font-mono',
    render: (rule) => rule.field || (rule.conditions ? `${rule.conditions.length} conditions` : '-'),
  },
  {
    id: 'priority',
    header: 'Priority',
    cellClassName: 'text-sm text-fg-muted',
    render: (rule) => rule.priority,
  },
];

function RuleTable({ rules }: { rules: ComplianceRule[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-default">
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
