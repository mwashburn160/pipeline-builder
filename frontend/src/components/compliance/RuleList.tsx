'use client';

import { useEffect, useState, useMemo } from 'react';
import { Shield, Plus, Pencil, Trash2, ToggleLeft, ToggleRight, History, Search, Tag } from 'lucide-react';
import api from '@/lib/api';
import { useCrudResource } from '@/hooks/useCrudResource';
import { useDebounce } from '@/hooks/useDebounce';
import { useDelete } from '@/hooks/useDelete';
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
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Pagination } from '@/components/ui/Pagination';
import { RecentlyDeletedPanel } from '@/components/RecentlyDeletedPanel';
import { InheritedBadge, inheritedReason } from './InheritedBadge';

interface RuleListProps {
  onEdit?: (rule: ComplianceRule) => void;
  onCreateNew?: () => void;
  onViewHistory?: (rule: ComplianceRule) => void;
}

type RuleParams = {
  name?: string; tag?: string; scope?: RuleScope; target?: RuleTarget; severity?: RuleSeverity;
  sortBy?: string; sortOrder?: string; limit?: number; offset?: number;
};

/** Typing in a search box waits this long before it becomes a request. */
const SEARCH_DEBOUNCE_MS = 300;
const DEFAULT_PAGE_SIZE = 25;

export default function RuleList({ onEdit, onCreateNew, onViewHistory }: RuleListProps) {
  const [targetFilter, setTargetFilter] = useState<RuleTarget | ''>('');
  const [severityFilter, setSeverityFilter] = useState<RuleSeverity | ''>('');
  const [scopeFilter, setScopeFilter] = useState<RuleScope | ''>('');
  const [nameSearch, setNameSearch] = useState('');
  const [tagSearch, setTagSearch] = useState('');
  const [sortBy, setSortBy] = useState<'priority' | 'name' | 'severity'>('priority');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState({ offset: 0, limit: DEFAULT_PAGE_SIZE });
  const debouncedName = useDebounce(nameSearch.trim(), SEARCH_DEBOUNCE_MS);
  const debouncedTag = useDebounce(tagSearch.trim(), SEARCH_DEBOUNCE_MS);

  // Any filter/sort change starts again from page 1.
  useEffect(() => {
    setPage((p) => (p.offset === 0 ? p : { ...p, offset: 0 }));
  }, [targetFilter, severityFilter, scopeFilter, debouncedName, debouncedTag, sortBy, sortOrder]);

  // Every filter, the sort and the page go to the server, so they apply across
  // ALL of the org's rules rather than just the rows already on screen.
  const crudApi = useMemo(() => ({
    list: async (params?: RuleParams) => {
      const merged: RuleParams = {
        ...params,
        ...(debouncedName ? { name: debouncedName } : {}),
        ...(debouncedTag ? { tag: debouncedTag } : {}),
        ...(scopeFilter ? { scope: scopeFilter } : {}),
        ...(targetFilter ? { target: targetFilter } : {}),
        ...(severityFilter ? { severity: severityFilter } : {}),
        // `severity` is stored as text, and alphabetical order (critical <
        // error < warning) IS the severity order, so the server sort matches.
        sortBy,
        sortOrder,
        limit: page.limit,
        offset: page.offset,
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
  }), [targetFilter, severityFilter, scopeFilter, debouncedName, debouncedTag, sortBy, sortOrder, page]);
  const { items: rules, total, loading, loadError, mutationError, clearError, fetch: fetchRules, remove: deleteRule, update: updateRule } = useCrudResource<ComplianceRule, ComplianceRuleCreate, ComplianceRuleUpdate, RuleParams>(crudApi, 'compliance rules');

  // Deleting a rule is confirmed via a modal. `deleteRule` never throws — a
  // failure lands in `mutationError` and renders inline above the list.
  const del = useDelete<ComplianceRule>((rule) => deleteRule(rule.id));

  // useCrudResource no longer auto-fetches on mount; trigger the initial
  // load and refetch when the server-forwarded filters change.
  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const filtersActive = Boolean(nameSearch || tagSearch || targetFilter || severityFilter || scopeFilter);

  const columns: Column<ComplianceRule>[] = [
    {
      id: 'name',
      header: 'Name',
      render: (rule) => (
        <>
          <div className="text-sm font-medium text-gray-900 dark:text-white">{rule.name}</div>
          {rule.description && <div className="text-xs text-fg-muted truncate max-w-xs">{rule.description}</div>}
          {rule.inherited && (
            <div className="mt-1">
              <InheritedBadge rule={rule} withReason reasonId={`inherited-reason-${rule.id}`} />
            </div>
          )}
          {rule.tags?.length > 0 && (
            <div className="flex gap-1 mt-1">
              {rule.tags.slice(0, 3).map(tag => (
                <span key={tag} className="text-2xs bg-gray-100 dark:bg-gray-700 text-fg-muted rounded px-1.5 py-0.5">{tag}</span>
              ))}
              {rule.tags.length > 3 && <span className="text-2xs text-fg-subtle">+{rule.tags.length - 3}</span>}
            </div>
          )}
        </>
      ),
    },
    {
      id: 'target',
      header: 'Target',
      render: (rule) => <StatusPill className="bg-gray-100 dark:bg-gray-700 text-fg-muted">{rule.target}</StatusPill>,
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
      cellClassName: 'text-sm text-fg-muted font-mono',
      render: (rule) => rule.field || (rule.conditions ? `${rule.conditions.length} conditions` : '-'),
    },
    {
      id: 'scope',
      header: 'Scope',
      render: (rule) => (
        <span className={`text-xs font-medium ${rule.scope === 'published' ? 'text-purple-600 dark:text-purple-400' : 'text-fg-muted'}`}>{rule.scope}</span>
      ),
    },
    {
      id: 'priority',
      header: 'Priority',
      cellClassName: 'text-sm text-fg-muted',
      render: (rule) => rule.priority,
    },
    {
      id: 'status',
      header: 'Status',
      render: (rule) => (
        <StatusPill className={rule.isActive ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-gray-700 text-fg-muted'}>
          {rule.isActive ? 'Active' : 'Inactive'}
        </StatusPill>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      render: (rule) => {
        // A parent-propagated rule is owned (and editable) only by its source
        // org; the API refuses team-side mutations. The controls stay VISIBLE
        // and disabled rather than vanishing: a row with no actions looks like a
        // rendering bug or a permission the viewer might have, and the reason is
        // spelled out under the rule's name where it can actually be read.
        const locked = !!rule.inherited;
        const lockReason = locked ? inheritedReason(rule) : undefined;
        const canMutate = !!onEdit;
        return (
        <div className="flex items-center justify-end gap-1">
          {canMutate && (
            <IconButton
              restTone={rule.isActive ? 'success' : 'default'}
              disabled={locked}
              className={locked ? 'opacity-40 cursor-not-allowed' : undefined}
              onClick={() => updateRule(rule.id, { isActive: !rule.isActive })}
              title={lockReason ?? (rule.isActive ? 'Deactivate' : 'Activate')}
              aria-label={rule.isActive ? 'Deactivate rule' : 'Activate rule'}
              aria-describedby={locked ? `inherited-reason-${rule.id}` : undefined}
            >
              {rule.isActive ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
            </IconButton>
          )}
          {onViewHistory && (
            <IconButton tone="indigo" onClick={() => onViewHistory(rule)} title="View history" aria-label="View history">
              <History className="h-4 w-4" />
            </IconButton>
          )}
          {canMutate && onEdit && (
            <IconButton
              tone="primary"
              disabled={locked}
              className={locked ? 'opacity-40 cursor-not-allowed' : undefined}
              onClick={() => onEdit(rule)}
              title={lockReason ?? 'Edit'}
              aria-label="Edit rule"
              aria-describedby={locked ? `inherited-reason-${rule.id}` : undefined}
            >
              <Pencil className="h-4 w-4" />
            </IconButton>
          )}
          {canMutate && (
            <IconButton
              tone="danger"
              disabled={locked}
              className={locked ? 'opacity-40 cursor-not-allowed' : undefined}
              onClick={() => del.open(rule)}
              title={lockReason ?? 'Delete'}
              aria-label="Delete rule"
              aria-describedby={locked ? `inherited-reason-${rule.id}` : undefined}
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
          )}
        </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-brand" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Compliance Rules ({total})
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
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-fg-subtle" />
          <FilterInput
            value={nameSearch}
            onChange={e => setNameSearch(e.target.value)}
            placeholder="Search by name..."
            aria-label="Search by name"
          />
        </div>
        <div className="relative min-w-[160px] max-w-[200px]">
          <Tag className="absolute left-2.5 top-2 h-4 w-4 text-fg-subtle" />
          <FilterInput
            value={tagSearch}
            onChange={e => setTagSearch(e.target.value)}
            placeholder="Tag..."
            aria-label="Filter by tag"
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

      {/* Errors and the loading spinner render inline so the filter bar and the
          recently-deleted panel stay mounted across a filter-driven refetch. */}
      <ErrorAlert message={loadError?.message} onRetry={() => fetchRules()} onDismiss={clearError} />
      <ErrorAlert message={mutationError?.message} onDismiss={clearError} />

      {/* Rule Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner label="Loading rules" />
        </div>
      ) : rules.length === 0 ? (
        <TextEmptyState>
          {filtersActive ? 'No rules match your filters.' : 'No compliance rules found. Create one to get started.'}
        </TextEmptyState>
      ) : (
        <div>
          <div className="overflow-x-auto">
            <DataTable
              data={rules}
              columns={columns}
              isLoading={false}
              getRowKey={(rule) => rule.id}
              emptyState={{ icon: Shield, title: 'No compliance rules', description: 'Create one to get started.' }}
            />
          </div>
          {total > page.limit && (
            <Pagination
              pagination={{ ...page, total }}
              onPageChange={(offset) => setPage((p) => ({ ...p, offset }))}
              onPageSizeChange={(limit) => setPage({ offset: 0, limit })}
            />
          )}
        </div>
      )}

      {/* Recently deleted — restore soft-deleted rules within the retention
          window. Gated on write (restore is compliance:write + step-up gated);
          `onEdit` is passed only for managers, so it mirrors that gate. */}
      {onEdit && <RecentlyDeletedPanel resource="compliance-rule" onRestored={() => fetchRules()} />}

      {del.target && (
        <DeleteConfirmModal
          title="Delete rule"
          itemName={del.target.name}
          loading={del.loading}
          onCancel={del.close}
          onConfirm={del.confirm}
        />
      )}
    </div>
  );
}
