// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for managing compliance policies — CRUD operations with loading/error states.
 */
import { useMemo } from 'react';
import api from '@/lib/api';
import { useCrudResource } from './useCrudResource';
import type { CompliancePolicy } from '@/types/compliance';

type PolicyCreate = { name: string; description?: string; version?: string; ruleNames?: string[] };
type PolicyUpdate = { name?: string; description?: string; version?: string; isActive?: boolean };
type PolicyParams = { name?: string; limit?: number; offset?: number };

export function useCompliancePolicies() {
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

  return { policies, loading, error, total, fetchPolicies, createPolicy, updatePolicy, deletePolicy };
}
