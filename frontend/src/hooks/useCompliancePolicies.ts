/**
 * Hook for managing compliance policies — CRUD operations with loading/error states.
 */
import { useState, useCallback } from 'react';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { useAsync } from './useAsync';
import type { CompliancePolicy } from '@/types/compliance';

interface UseCompliancePoliciesReturn {
  policies: CompliancePolicy[];
  loading: boolean;
  error: string | null;
  total: number;
  fetchPolicies: (params?: { name?: string; limit?: number; offset?: number }) => Promise<void>;
  createPolicy: (data: { name: string; description?: string; version?: string; ruleNames?: string[] }) => Promise<CompliancePolicy | null>;
  updatePolicy: (id: string, data: { name?: string; description?: string; version?: string; isActive?: boolean }) => Promise<CompliancePolicy | null>;
  deletePolicy: (id: string) => Promise<boolean>;
}

export function useCompliancePolicies(): UseCompliancePoliciesReturn {
  const [policies, setPolicies] = useState<CompliancePolicy[]>([]);
  const [total, setTotal] = useState(0);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const { loading, error: fetchError } = useAsync(async () => {
    const res = await api.getCompliancePolicies();
    if (res.success && res.data) {
      setPolicies(res.data.policies);
      setTotal(res.data.pagination?.total ?? res.data.policies.length);
    }
  }, []);

  const fetchPolicies = useCallback(async (params?: { name?: string; limit?: number; offset?: number }) => {
    try {
      setMutationError(null);
      const res = await api.getCompliancePolicies(params);
      if (res.success && res.data) {
        setPolicies(res.data.policies);
        setTotal(res.data.pagination?.total ?? res.data.policies.length);
      }
    } catch (err) {
      setMutationError(formatError(err, 'Failed to fetch policies'));
    }
  }, []);

  const createPolicy = useCallback(async (data: { name: string; description?: string; version?: string; ruleNames?: string[] }): Promise<CompliancePolicy | null> => {
    try {
      const res = await api.createCompliancePolicy(data);
      if (res.success && res.data) {
        const policy = res.data.policy;
        setPolicies((prev) => [policy, ...prev]);
        return policy;
      }
      return null;
    } catch (err) {
      setMutationError(formatError(err, 'Failed to create policy'));
      return null;
    }
  }, []);

  const updatePolicy = useCallback(async (id: string, data: { name?: string; description?: string; version?: string; isActive?: boolean }): Promise<CompliancePolicy | null> => {
    try {
      const res = await api.updateCompliancePolicy(id, data);
      if (res.success && res.data) {
        const policy = res.data.policy;
        setPolicies((prev) => prev.map((p) => (p.id === id ? policy : p)));
        return policy;
      }
      return null;
    } catch (err) {
      setMutationError(formatError(err, 'Failed to update policy'));
      return null;
    }
  }, []);

  const deletePolicy = useCallback(async (id: string): Promise<boolean> => {
    try {
      await api.deleteCompliancePolicy(id);
      setPolicies((prev) => prev.filter((p) => p.id !== id));
      return true;
    } catch (err) {
      setMutationError(formatError(err, 'Failed to delete policy'));
      return false;
    }
  }, []);

  return { policies, loading, error: mutationError || fetchError, total, fetchPolicies, createPolicy, updatePolicy, deletePolicy };
}
