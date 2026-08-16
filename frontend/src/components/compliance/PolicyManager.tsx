'use client';

import { useEffect, useMemo, useState } from 'react';
import { FileText, Plus, Pencil, Trash2, ToggleLeft, ToggleRight } from 'lucide-react';
import { StatusPill } from '@/components/ui/StatusPill';
import { TextEmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { RecentlyDeletedPanel } from '@/components/RecentlyDeletedPanel';
import api from '@/lib/api';
import { useCrudResource } from '@/hooks/useCrudResource';
import type { CompliancePolicy } from '@/types/compliance';

interface PolicyManagerProps {
  readOnly?: boolean;
}

type PolicyCreate = { name: string; description?: string; version?: string; ruleNames?: string[] };
type PolicyUpdate = { name?: string; description?: string; version?: string; isActive?: boolean };
type PolicyParams = { name?: string; limit?: number; offset?: number };

export default function PolicyManager({ readOnly = false }: PolicyManagerProps) {
  const crudApi = useMemo(() => ({
    list: async (params?: PolicyParams) => {
      const res = await api.getCompliancePolicies(params);
      return { success: res.success, data: res.data ? { items: res.data.policies, pagination: res.data.pagination } : undefined };
    },
    create: async (data: PolicyCreate) => {
      const res = await api.createCompliancePolicy(data);
      return { success: res.success, data: res.data ? { item: res.data.policy } : undefined };
    },
    update: async (id: string, data: PolicyUpdate) => {
      const res = await api.updateCompliancePolicy(id, data);
      return { success: res.success, data: res.data ? { item: res.data.policy } : undefined };
    },
    delete: (id: string) => api.deleteCompliancePolicy(id),
  }), []);
  const { items: policies, loading, error, total, fetch: fetchPolicies, create: createPolicy, update: updatePolicy, remove: deletePolicy } = useCrudResource<CompliancePolicy, PolicyCreate, PolicyUpdate, PolicyParams>(crudApi, 'compliance policies');

  // useCrudResource no longer auto-fetches; trigger the initial load.
  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', description: '', version: '1.0.0' });

  const handleSubmit = async () => {
    if (!form.name) return;
    // create/update return null on failure (the hook surfaces the error). Keep
    // the form open in that case so the user's input isn't silently discarded.
    const result = editingId
      ? await updatePolicy(editingId, form)
      : await createPolicy(form);
    if (!result) return;
    setShowForm(false);
    setEditingId(null);
    setForm({ name: '', description: '', version: '1.0.0' });
  };

  const handleEdit = (policy: CompliancePolicy) => {
    setEditingId(policy.id);
    setForm({ name: policy.name, description: policy.description || '', version: policy.version });
    setShowForm(true);
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingId(null);
    setForm({ name: '', description: '', version: '1.0.0' });
  };

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

  const columns: Column<CompliancePolicy>[] = [
    {
      id: 'name',
      header: 'Name',
      render: (policy) => (
        <>
          <div className="text-sm font-medium text-gray-900 dark:text-white">{policy.name}</div>
          {policy.description && <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-xs">{policy.description}</div>}
        </>
      ),
    },
    { id: 'version', header: 'Version', render: (policy) => <span className="text-sm text-gray-600 dark:text-gray-400 font-mono">{policy.version}</span> },
    {
      id: 'status',
      header: 'Status',
      render: (policy) => (
        <StatusPill className={policy.isActive ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-gray-700 text-gray-500'}>
          {policy.isActive ? 'Active' : 'Inactive'}
        </StatusPill>
      ),
    },
    { id: 'created', header: 'Created', cellClassName: 'text-xs text-gray-500', render: (policy) => new Date(policy.createdAt).toLocaleDateString() },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      render: (policy) => (!readOnly ? (
        <div className="flex items-center justify-end gap-1">
          <IconButton
            restTone={policy.isActive ? 'success' : 'default'}
            onClick={() => updatePolicy(policy.id, { isActive: !policy.isActive })}
            title={policy.isActive ? 'Deactivate' : 'Activate'}
            aria-label={policy.isActive ? 'Deactivate policy' : 'Activate policy'}
          >
            {policy.isActive ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
          </IconButton>
          <IconButton tone="primary" onClick={() => handleEdit(policy)} aria-label="Edit policy">
            <Pencil className="h-4 w-4" />
          </IconButton>
          <IconButton tone="danger" onClick={() => deletePolicy(policy.id)} aria-label="Delete policy">
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </div>
      ) : null),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-purple-600" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Compliance Policies ({total})
          </h2>
        </div>
        {!readOnly && (
          <Button
            variant="purple"
            onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: '', description: '', version: '1.0.0' }); }}
            className="gap-1.5"
          >
            <Plus className="h-4 w-4" />
            New Policy
          </Button>
        )}
      </div>

      {showForm && (
        <div className="p-4 rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/20 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Policy name"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
            <Input
              placeholder="Version (e.g. 1.0.0)"
              value={form.version}
              onChange={e => setForm(f => ({ ...f, version: e.target.value }))}
            />
          </div>
          <Textarea
            placeholder="Description (optional)"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            rows={2}
          />
          <div className="flex gap-2">
            <Button variant="purple" size="sm" onClick={handleSubmit}>
              {editingId ? 'Update' : 'Create'} Policy
            </Button>
            <Button variant="secondary" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {policies.length === 0 ? (
        <TextEmptyState>
          No compliance policies found. Create one to group and manage rules.
        </TextEmptyState>
      ) : (
        <div className="overflow-x-auto">
          <DataTable
            data={policies}
            columns={columns}
            isLoading={false}
            getRowKey={(policy) => policy.id}
            emptyState={{ icon: FileText, title: 'No compliance policies', description: 'Create one to group and manage rules.' }}
          />
        </div>
      )}

      {/* Recently deleted — restore soft-deleted policies within the retention
          window. Gated on write (restore is compliance:write + step-up gated). */}
      {!readOnly && <RecentlyDeletedPanel resource="compliance-policy" onRestored={fetchPolicies} />}
    </div>
  );
}
