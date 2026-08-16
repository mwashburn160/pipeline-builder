'use client';

import { useEffect, useState, useMemo } from 'react';
import { Shield, Plus, Pencil, Trash2, ToggleLeft, ToggleRight, History, Search } from 'lucide-react';
import api from '@/lib/api';
import { useCrudResource } from '@/hooks/useCrudResource';
import type { ComplianceRule, ComplianceRuleCreate, ComplianceRuleUpdate, RuleTarget, RuleSeverity, RuleScope } from '@/types/compliance';
import { SEVERITY_CONFIG } from '@/lib/compliance-styles';
import { StatusPill } from '@/components/ui/StatusPill';
import { TextEmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { FilterInput } from '@/components/ui/FilterInput';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { RecentlyDeletedPanel } from '@/components/RecentlyDeletedPanel';

interface RuleListProps {
  onEdit?: (rule: ComplianceRule) => void;
  onCreateNew?: () => void;
  onViewHistory?: (rule: ComplianceRule) => void;
}

// `scope` and `name` aren't part of the server-side filter surface today, so
// we still filter those client-side. `target`/`severity` are forwarded to
// the API; this prevents the previous "client-filter on already-server-
// filtered data" duplication that quietly truncated paginated results.
type RuleParams = { target?: RuleTarget; severity?: RuleSeverity; policyId?: string; limit?: number; offset?: number };

export default function RuleList({ onEdit, onCreateNew, onViewHistory }: RuleListProps) {
  const [targetFilter, setTargetFilter] = useState<RuleTarget | ''>('');
  const [severityFilter, setSeverityFilter] = useState<RuleSeverity | ''>('');
  const [scopeFilter, setScopeFilter] = useState<RuleScope | ''>('');
  const [nameSearch, setNameSearch] = useState('');
  const [sortBy, setSortBy] = useState<'priority' | 'name' | 'severity'>('priority');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const crudApi = useMemo(() => ({
    list: async (params?: RuleParams) => {
      // Forward target/severity to the server. Other filters (scope, name
      // search) remain client-side because the API doesn't accept them.
      const merged: RuleParams = {
        ...params,
        ...(targetFilter ? { target: targetFilter } : {}),
        ...(severityFilter ? { severity: severityFilter } : {}),
      };
      const res = await api.getComplianceRules(merged);
      return { success: res.success, data: res.data ? { items: res.data.rules, pagination: res.data.pagination } : undefined };
    },
    create: async (data: ComplianceRuleCreate) => {
      const res = await api.createComplianceRule(data);
      return { success: res.success, data: res.data ? { item: res.data.rule } : undefined };
    },
    update: async (id: string, data: ComplianceRuleUpdate) => {
      const res = await api.updateComplianceRule(id, data);
      return { success: res.success, data: res.data ? { item: res.data.rule } : undefined };
    },
    delete: (id: string) => api.deleteComplianceRule(id),
  }), [targetFilter, severityFilter]);
  const { items: rules, loading, error, fetch: fetchRules, remove: deleteRule, update: updateRule } = useCrudResource<ComplianceRule, ComplianceRuleCreate, ComplianceRuleUpdate, RuleParams>(crudApi, 'compliance rules');

  // useCrudResource no longer auto-fetches on mount; trigger the initial
  // load and refetch when the server-forwarded filters change.
  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const filteredRules = useMemo(() => {
    // Only scope + nameSearch run client-side now (target/severity are
    // applied server-side by `crudApi.list`).
    let result = rules.filter((rule) => {
      if (scopeFilter && rule.scope !== scopeFilter) return false;
      if (nameSearch && !rule.name.toLowerCase().includes(nameSearch.toLowerCase())) return false;
      return true;
    });
    const sevOrder: Record<string, number> = { critical: 0, error: 1, warning: 2 };
    result.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'priority') cmp = a.priority - b.priority;
      else if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortBy === 'severity') cmp = (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9);
      return sortOrder === 'desc' ? -cmp : cmp;
    });
    return result;
  }, [rules, scopeFilter, nameSearch, sortBy, sortOrder]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return <ErrorAlert message={error.message} />;
  }

  const columns: Column<ComplianceRule>[] = [
    {
      id: 'name',
      header: 'Name',
      render: (rule) => (
        <>
          <div className="text-sm font-medium text-gray-900 dark:text-white">{rule.name}</div>
          {rule.description && <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-xs">{rule.description}</div>}
          {rule.tags?.length > 0 && (
            <div className="flex gap-1 mt-1">
              {rule.tags.slice(0, 3).map(tag => (
                <span key={tag} className="text-[10px] bg-gray-100 dark:bg-gray-700 text-gray-500 rounded px-1.5 py-0.5">{tag}</span>
              ))}
              {rule.tags.length > 3 && <span className="text-[10px] text-gray-400">+{rule.tags.length - 3}</span>}
            </div>
          )}
        </>
      ),
    },
    {
      id: 'target',
      header: 'Target',
      render: (rule) => <StatusPill className="bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">{rule.target}</StatusPill>,
    },
    {
      id: 'severity',
      header: 'Severity',
      render: (rule) => {
        const sev = SEVERITY_CONFIG[rule.severity];
        const SevIcon = sev.icon;
        return (
          <StatusPill gap className={`${sev.bg} ${sev.color}`}>
            <SevIcon className="h-3 w-3" /> {rule.severity}
          </StatusPill>
        );
      },
    },
    {
      id: 'field',
      header: 'Field',
      cellClassName: 'text-sm text-gray-600 dark:text-gray-400 font-mono',
      render: (rule) => rule.field || (rule.conditions ? `${rule.conditions.length} conditions` : '-'),
    },
    {
      id: 'scope',
      header: 'Scope',
      render: (rule) => (
        <span className={`text-xs font-medium ${rule.scope === 'published' ? 'text-purple-600 dark:text-purple-400' : 'text-gray-600 dark:text-gray-400'}`}>{rule.scope}</span>
      ),
    },
    {
      id: 'priority',
      header: 'Priority',
      cellClassName: 'text-sm text-gray-600 dark:text-gray-400',
      render: (rule) => rule.priority,
    },
    {
      id: 'status',
      header: 'Status',
      render: (rule) => (
        <StatusPill className={rule.isActive ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-gray-700 text-gray-500'}>
          {rule.isActive ? 'Active' : 'Inactive'}
        </StatusPill>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      render: (rule) => (
        <div className="flex items-center justify-end gap-1">
          {onEdit && (
            <IconButton
              restTone={rule.isActive ? 'success' : 'default'}
              onClick={() => updateRule(rule.id, { isActive: !rule.isActive })}
              title={rule.isActive ? 'Deactivate' : 'Activate'}
              aria-label={rule.isActive ? 'Deactivate rule' : 'Activate rule'}
            >
              {rule.isActive ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
            </IconButton>
          )}
          {onViewHistory && (
            <IconButton tone="indigo" onClick={() => onViewHistory(rule)} title="View history" aria-label="View history">
              <History className="h-4 w-4" />
            </IconButton>
          )}
          {onEdit && (
            <IconButton tone="primary" onClick={() => onEdit(rule)} title="Edit" aria-label="Edit rule">
              <Pencil className="h-4 w-4" />
            </IconButton>
          )}
          {onEdit && (
            <IconButton tone="danger" onClick={() => deleteRule(rule.id)} title="Delete" aria-label="Delete rule">
              <Trash2 className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-blue-600" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Compliance Rules ({filteredRules.length})
          </h2>
        </div>
        {onCreateNew && (
          <Button variant="primary" onClick={onCreateNew}>
            <Plus className="h-4 w-4" /> New Rule
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-gray-400" />
          <FilterInput
            value={nameSearch}
            onChange={e => setNameSearch(e.target.value)}
            placeholder="Search by name..."
            aria-label="Search by name"
          />
        </div>
        <FilterSelect value={targetFilter} onChange={e => setTargetFilter(e.target.value as RuleTarget | '')} aria-label="Filter rules by target">
          <option value="">All targets</option>
          <option value="plugin">Plugin</option>
          <option value="pipeline">Pipeline</option>
        </FilterSelect>
        <FilterSelect value={severityFilter} onChange={e => setSeverityFilter(e.target.value as RuleSeverity | '')} aria-label="Filter rules by severity">
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="error">Error</option>
          <option value="warning">Warning</option>
        </FilterSelect>
        <FilterSelect value={scopeFilter} onChange={e => setScopeFilter(e.target.value as RuleScope | '')} aria-label="Filter rules by scope">
          <option value="">All scopes</option>
          <option value="org">Org</option>
          <option value="published">Published</option>
        </FilterSelect>
        <FilterSelect value={`${sortBy}-${sortOrder}`} onChange={e => { const [s, o] = e.target.value.split('-'); setSortBy(s as typeof sortBy); setSortOrder(o as typeof sortOrder); }} aria-label="Sort rules">
          <option value="priority-asc">Priority (low first)</option>
          <option value="priority-desc">Priority (high first)</option>
          <option value="name-asc">Name A-Z</option>
          <option value="name-desc">Name Z-A</option>
          <option value="severity-asc">Severity (critical first)</option>
          <option value="severity-desc">Severity (warning first)</option>
        </FilterSelect>
      </div>

      {/* Rule Table */}
      {filteredRules.length === 0 ? (
        <TextEmptyState>
          {nameSearch || targetFilter || severityFilter || scopeFilter ? 'No rules match your filters.' : 'No compliance rules found. Create one to get started.'}
        </TextEmptyState>
      ) : (
        <div className="overflow-x-auto">
          <DataTable
            data={filteredRules}
            columns={columns}
            isLoading={false}
            getRowKey={(rule) => rule.id}
            emptyState={{ icon: Shield, title: 'No compliance rules', description: 'Create one to get started.' }}
          />
        </div>
      )}

      {/* Recently deleted — restore soft-deleted rules within the retention
          window. Gated on write (restore is compliance:write + step-up gated);
          `onEdit` is passed only for managers, so it mirrors that gate. */}
      {onEdit && <RecentlyDeletedPanel resource="compliance-rule" onRestored={fetchRules} />}
    </div>
  );
}
