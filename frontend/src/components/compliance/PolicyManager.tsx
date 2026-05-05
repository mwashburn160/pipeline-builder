'use client';

import { useMemo, useState } from 'react';
import { FileText, Plus, Pencil, Trash2, ToggleLeft, ToggleRight } from 'lucide-react';
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
  const { items: policies, loading, error, total, create: createPolicy, update: updatePolicy, remove: deletePolicy } = useCrudResource<CompliancePolicy, PolicyCreate, PolicyUpdate, PolicyParams>(crudApi, 'compliance policies');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', description: '', version: '1.0.0' });

  const handleSubmit = async () => {
    if (!form.name) return;
    if (editingId) {
      await updatePolicy(editingId, form);
    } else {
      await createPolicy(form);
    }
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
    return (
      <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-4 text-red-700 dark:text-red-300">
        {error}
      </div>
    );
  }

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
          <button
            onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: '', description: '', version: '1.0.0' }); }}
            className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-white hover:bg-purple-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New Policy
          </button>
        )}
      </div>

      {showForm && (
        <div className="p-4 rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/20 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Policy name"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
            />
            <input
              placeholder="Version (e.g. 1.0.0)"
              value={form.version}
              onChange={e => setForm(f => ({ ...f, version: e.target.value }))}
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
            />
          </div>
          <textarea
            placeholder="Description (optional)"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
            rows={2}
          />
          <div className="flex gap-2">
            <button onClick={handleSubmit} className="px-3 py-1.5 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700">
              {editingId ? 'Update' : 'Create'} Policy
            </button>
            <button onClick={handleCancel} className="px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg">
              Cancel
            </button>
          </div>
        </div>
      )}

      {policies.length === 0 ? (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
          No compliance policies found. Create one to group and manage rules.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Version</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Created</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
              {policies.map((policy) => (
                <tr key={policy.id} className="hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-gray-900 dark:text-white">{policy.name}</div>
                    {policy.description && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-xs">{policy.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm text-gray-600 dark:text-gray-400 font-mono">{policy.version}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      policy.isActive
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-500'
                    }`}>
                      {policy.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{new Date(policy.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    {!readOnly && (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => updatePolicy(policy.id, { isActive: !policy.isActive })}
                          className={`p-1.5 rounded-lg transition-colors ${policy.isActive ? 'text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20' : 'text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
                          title={policy.isActive ? 'Deactivate' : 'Activate'}
                          aria-label={policy.isActive ? 'Deactivate policy' : 'Activate policy'}
                        >
                          {policy.isActive ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
                        </button>
                        <button
                          onClick={() => handleEdit(policy)}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                          aria-label="Edit policy"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => deletePolicy(policy.id)}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                          aria-label="Delete policy"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
