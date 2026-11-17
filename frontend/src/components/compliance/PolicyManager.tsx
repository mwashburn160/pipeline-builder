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
import { ConcurrencyConflictAlert } from '@/components/ui/ConcurrencyConflictAlert';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RecentlyDeletedPanel } from '@/components/RecentlyDeletedPanel';
import api from '@/lib/api';
import { expectedUpdatedAtOf, isConcurrencyConflict } from '@/lib/api/concurrency';
import { useCrudResource } from '@/hooks/useCrudResource';
import { useDelete } from '@/hooks/useDelete';
import { useMutation } from '@/hooks/useMutation';
import type { CompliancePolicy } from '@/types/compliance';
import { formatDate } from '@/lib/format';

interface PolicyManagerProps {
  readOnly?: boolean;
}

type PolicyCreate = { name: string; description?: string; version?: string; rules?: string[] };
type PolicyUpdate = { name?: string; description?: string; version?: string; isActive?: boolean; expectedUpdatedAt?: string };
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
  const { items: policies, loading, loadError, mutationError, clearError, total, fetch: fetchPolicies, create: createPolicy, update: updatePolicy, remove: deletePolicy } = useCrudResource<CompliancePolicy, PolicyCreate, PolicyUpdate, PolicyParams>(crudApi, 'compliance policies');

  // useCrudResource doesn't auto-fetch; trigger the initial load.
  useEffect(() => {
    void fetchPolicies();
  }, [fetchPolicies]);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  /** The `updatedAt` of the policy the form was opened on — sent as `expectedUpdatedAt`. */
  const [editingUpdatedAt, setEditingUpdatedAt] = useState<string | undefined>(undefined);
  /** After a conflict's Reload: re-seed the open form from the re-read row. */
  const [reseedPending, setReseedPending] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', version: '1.0.0' });
  // Deleting a policy is confirmed via a modal. `deletePolicy` never throws — a
  // failure lands in `mutationError` and renders inline above the list.
  const del = useDelete<CompliancePolicy>((policy) => deletePolicy(policy.id));
  // Create/update had no in-flight state — repeated clicks fired repeated writes.
  // create/update never throw and resolve null on failure (the crud hook
  // surfaces the error); keep the form open then so input isn't discarded.
  const save = useMutation({
    fn: (id: string | null, data: typeof form) => (id
      // Conditional on the version the form opened: a concurrent edit is a 412, not an overwrite.
      ? updatePolicy(id, { ...data, expectedUpdatedAt: editingUpdatedAt })
      : createPolicy(data)),
    onSuccess: (result) => {
      if (!result) return;
      setShowForm(false);
      setEditingId(null);
      setEditingUpdatedAt(undefined);
      setForm({ name: '', description: '', version: '1.0.0' });
    },
  });
  const saving = save.pending;

  const handleSubmit = async () => {
    if (!form.name) return;
    await save.run(editingId, form);
  };

  const handleEdit = (policy: CompliancePolicy) => {
    setEditingId(policy.id);
    setEditingUpdatedAt(expectedUpdatedAtOf(policy));
    setForm({ name: policy.name, description: policy.description || '', version: policy.version });
    setShowForm(true);
  };

  // A save refused as a concurrent edit: re-read the list, then reset the open
  // form to the latest version of its policy (this edit is discarded).
  const conflict = isConcurrencyConflict(mutationError);
  const handleReload = async () => {
    clearError();
    await fetchPolicies();
    setReseedPending(true);
  };
  useEffect(() => {
    if (!reseedPending) return;
    setReseedPending(false);
    const fresh = editingId ? policies.find((p) => p.id === editingId) : undefined;
    if (!fresh) return;
    setEditingUpdatedAt(expectedUpdatedAtOf(fresh));
    setForm({ name: fresh.name, description: fresh.description || '', version: fresh.version });
  }, [reseedPending, editingId, policies]);

  const handleCancel = () => {
    setShowForm(false);
    setEditingId(null);
    setEditingUpdatedAt(undefined);
    setForm({ name: '', description: '', version: '1.0.0' });
  };

  const columns: Column<CompliancePolicy>[] = [
    {
      id: 'name',
      header: 'Name',
      render: (policy) => (
        <>
          <div className="text-sm font-medium text-fg">{policy.name}</div>
          {policy.description && <div className="text-xs text-fg-muted truncate max-w-xs">{policy.description}</div>}
        </>
      ),
    },
    { id: 'version', header: 'Version', render: (policy) => <span className="text-sm text-fg-muted font-mono">{policy.version}</span> },
    {
      id: 'status',
      header: 'Status',
      render: (policy) => (
        <StatusPill className={policy.isActive ? 'bg-success-bg text-success' : 'bg-surface-muted text-fg-muted'}>
          {policy.isActive ? 'Active' : 'Inactive'}
        </StatusPill>
      ),
    },
    { id: 'created', header: 'Created', cellClassName: 'text-xs text-fg-muted', render: (policy) => formatDate(policy.createdAt) },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      render: (policy) => (!readOnly ? (
        <div className="flex items-center justify-end gap-1">
          <IconButton
            restTone={policy.isActive ? 'success' : 'default'}
            onClick={() => updatePolicy(policy.id, { isActive: !policy.isActive, expectedUpdatedAt: expectedUpdatedAtOf(policy) })}
            title={policy.isActive ? 'Deactivate' : 'Activate'}
            aria-label={policy.isActive ? 'Deactivate policy' : 'Activate policy'}
          >
            {policy.isActive ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
          </IconButton>
          <IconButton tone="primary" onClick={() => handleEdit(policy)} aria-label="Edit policy">
            <Pencil className="h-4 w-4" />
          </IconButton>
          <IconButton tone="danger" onClick={() => del.open(policy)} aria-label="Delete policy">
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
          <FileText className="h-5 w-5 text-purple-600 dark:text-purple-400" />
          <h2 className="text-lg font-semibold text-fg">
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
            <Button variant="purple" size="sm" onClick={handleSubmit} loading={saving} disabled={!form.name.trim()}>
              {editingId ? 'Update' : 'Create'} Policy
            </Button>
            <Button variant="secondary" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Errors render inline so the list (and the form's input) stay put. A
          load failure offers Retry; a mutation failure is dismissible. */}
      <ErrorAlert message={loadError?.message} onRetry={() => fetchPolicies()} onDismiss={clearError} />
      {conflict ? (
        <ConcurrencyConflictAlert show onReload={() => void handleReload()} reloading={loading} />
      ) : (
        <ErrorAlert message={mutationError?.message} onDismiss={clearError} />
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner label="Loading policies" />
        </div>
      ) : policies.length === 0 ? (
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
      {!readOnly && <RecentlyDeletedPanel resource="compliance-policy" onRestored={() => fetchPolicies()} />}

      {del.target && (
        <DeleteConfirmModal
          title="Delete policy"
          itemName={del.target.name}
          loading={del.loading}
          onCancel={del.close}
          onConfirm={del.confirm}
        />
      )}
    </div>
  );
}
