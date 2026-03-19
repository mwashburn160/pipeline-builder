/**
 * Hook for managing compliance rules — CRUD operations with loading/error states.
 * Uses useAsync for initial fetch and useAsyncCallback for mutations.
 */
import { useState, useCallback } from 'react';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { useAsync } from './useAsync';
import type { ComplianceRule, ComplianceRuleCreate, ComplianceRuleUpdate, RuleTarget, RuleSeverity } from '@/types/compliance';

interface UseComplianceRulesReturn {
  rules: ComplianceRule[];
  loading: boolean;
  error: string | null;
  total: number;
  fetchRules: (params?: { target?: RuleTarget; severity?: RuleSeverity; policyId?: string; limit?: number; offset?: number }) => Promise<void>;
  createRule: (data: ComplianceRuleCreate) => Promise<ComplianceRule | null>;
  updateRule: (id: string, data: ComplianceRuleUpdate) => Promise<ComplianceRule | null>;
  deleteRule: (id: string) => Promise<boolean>;
}

export function useComplianceRules(): UseComplianceRulesReturn {
  const [rules, setRules] = useState<ComplianceRule[]>([]);
  const [total, setTotal] = useState(0);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const { loading, error: fetchError } = useAsync(async () => {
    const res = await api.getComplianceRules();
    if (res.success && res.data) {
      setRules(res.data.rules);
      setTotal(res.data.pagination?.total ?? res.data.rules.length);
    }
  }, []);

  const fetchRules = useCallback(async (params?: { target?: RuleTarget; severity?: RuleSeverity; policyId?: string; limit?: number; offset?: number }) => {
    try {
      setMutationError(null);
      const res = await api.getComplianceRules(params);
      if (res.success && res.data) {
        setRules(res.data.rules);
        setTotal(res.data.pagination?.total ?? res.data.rules.length);
      }
    } catch (err) {
      setMutationError(formatError(err, 'Failed to fetch compliance rules'));
    }
  }, []);

  const createRule = useCallback(async (data: ComplianceRuleCreate): Promise<ComplianceRule | null> => {
    try {
      const res = await api.createComplianceRule(data);
      if (res.success && res.data) {
        const rule = res.data.rule;
        setRules((prev) => [rule, ...prev]);
        return rule;
      }
      return null;
    } catch (err) {
      setMutationError(formatError(err, 'Failed to create rule'));
      return null;
    }
  }, []);

  const updateRule = useCallback(async (id: string, data: ComplianceRuleUpdate): Promise<ComplianceRule | null> => {
    try {
      const res = await api.updateComplianceRule(id, data);
      if (res.success && res.data) {
        const rule = res.data.rule;
        setRules((prev) => prev.map((r) => (r.id === id ? rule : r)));
        return rule;
      }
      return null;
    } catch (err) {
      setMutationError(formatError(err, 'Failed to update rule'));
      return null;
    }
  }, []);

  const deleteRule = useCallback(async (id: string): Promise<boolean> => {
    try {
      await api.deleteComplianceRule(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
      return true;
    } catch (err) {
      setMutationError(formatError(err, 'Failed to delete rule'));
      return false;
    }
  }, []);

  return { rules, loading, error: mutationError || fetchError, total, fetchRules, createRule, updateRule, deleteRule };
}
