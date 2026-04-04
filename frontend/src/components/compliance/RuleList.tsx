'use client';

import { useState, useMemo } from 'react';
import { Shield, Plus, Pencil, Trash2, ToggleLeft, ToggleRight, History, Search } from 'lucide-react';
import type { ComplianceRule, RuleTarget, RuleSeverity, RuleScope } from '@/types/compliance';
import { useComplianceRules } from '@/hooks/useComplianceRules';
import { SEVERITY_CONFIG } from '@/lib/compliance-styles';

interface RuleListProps {
  onEdit?: (rule: ComplianceRule) => void;
  onCreateNew?: () => void;
  onViewHistory?: (rule: ComplianceRule) => void;
}

export default function RuleList({ onEdit, onCreateNew, onViewHistory }: RuleListProps) {
  const { rules, loading, error, total, deleteRule, updateRule } = useComplianceRules();
  const [targetFilter, setTargetFilter] = useState<RuleTarget | ''>('');
  const [severityFilter, setSeverityFilter] = useState<RuleSeverity | ''>('');
  const [scopeFilter, setScopeFilter] = useState<RuleScope | ''>('');
  const [nameSearch, setNameSearch] = useState('');
  const [sortBy, setSortBy] = useState<'priority' | 'name' | 'severity'>('priority');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const filteredRules = useMemo(() => {
    let result = rules.filter((rule) => {
      if (targetFilter && rule.target !== targetFilter) return false;
      if (severityFilter && rule.severity !== severityFilter) return false;
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
  }, [rules, targetFilter, severityFilter, scopeFilter, nameSearch, sortBy, sortOrder]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-4 text-red-700 dark:text-red-300">{error}</div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-blue-600" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Compliance Rules ({total})
          </h2>
        </div>
        {onCreateNew && (
          <button onClick={onCreateNew} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors">
            <Plus className="h-4 w-4" /> New Rule
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-gray-400" />
          <input
            value={nameSearch}
            onChange={e => setNameSearch(e.target.value)}
            placeholder="Search by name..."
            aria-label="Search by name"
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 pl-8 pr-3 py-1.5 text-sm"
          />
        </div>
        <select value={targetFilter} onChange={e => setTargetFilter(e.target.value as RuleTarget | '')} className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm">
          <option value="">All targets</option>
          <option value="plugin">Plugin</option>
          <option value="pipeline">Pipeline</option>
        </select>
        <select value={severityFilter} onChange={e => setSeverityFilter(e.target.value as RuleSeverity | '')} className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm">
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="error">Error</option>
          <option value="warning">Warning</option>
        </select>
        <select value={scopeFilter} onChange={e => setScopeFilter(e.target.value as RuleScope | '')} className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm">
          <option value="">All scopes</option>
          <option value="org">Org</option>
          <option value="published">Published</option>
        </select>
        <select value={`${sortBy}-${sortOrder}`} onChange={e => { const [s, o] = e.target.value.split('-'); setSortBy(s as typeof sortBy); setSortOrder(o as typeof sortOrder); }} className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm">
          <option value="priority-asc">Priority (low first)</option>
          <option value="priority-desc">Priority (high first)</option>
          <option value="name-asc">Name A-Z</option>
          <option value="name-desc">Name Z-A</option>
          <option value="severity-asc">Severity (critical first)</option>
          <option value="severity-desc">Severity (warning first)</option>
        </select>
      </div>

      {/* Rule Table */}
      {filteredRules.length === 0 ? (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
          {nameSearch || targetFilter || severityFilter || scopeFilter ? 'No rules match your filters.' : 'No compliance rules found. Create one to get started.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Target</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Severity</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Field</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Scope</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Priority</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
              {filteredRules.map((rule) => {
                const sev = SEVERITY_CONFIG[rule.severity];
                const SevIcon = sev.icon;
                return (
                  <tr key={rule.id} className="hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                    <td className="px-4 py-3">
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
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">{rule.target}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${sev.bg} ${sev.color}`}>
                        <SevIcon className="h-3 w-3" /> {rule.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 font-mono">
                      {rule.field || (rule.conditions ? `${rule.conditions.length} conditions` : '-')}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium ${rule.scope === 'published' ? 'text-purple-600 dark:text-purple-400' : 'text-gray-600 dark:text-gray-400'}`}>{rule.scope}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{rule.priority}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        rule.isActive ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-gray-700 text-gray-500'
                      }`}>{rule.isActive ? 'Active' : 'Inactive'}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {onEdit && (
                          <button
                            onClick={() => updateRule(rule.id, { isActive: !rule.isActive })}
                            className={`p-1.5 rounded-lg transition-colors ${rule.isActive ? 'text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20' : 'text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
                            title={rule.isActive ? 'Deactivate' : 'Activate'}
                            aria-label={rule.isActive ? 'Deactivate rule' : 'Activate rule'}
                          >
                            {rule.isActive ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
                          </button>
                        )}
                        {onViewHistory && (
                          <button onClick={() => onViewHistory(rule)} className="p-1.5 rounded-lg text-gray-400 hover:text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors" title="View history" aria-label="View history">
                            <History className="h-4 w-4" />
                          </button>
                        )}
                        {onEdit && (
                          <button onClick={() => onEdit(rule)} className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" title="Edit" aria-label="Edit rule">
                            <Pencil className="h-4 w-4" />
                          </button>
                        )}
                        {onEdit && (
                          <button onClick={() => deleteRule(rule.id)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" title="Delete" aria-label="Delete rule">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
