/**
 * Hook for managing compliance rules — CRUD operations with loading/error states.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  const fetchRules = useCallback(async (params?: { target?: RuleTarget; severity?: RuleSeverity; policyId?: string; limit?: number; offset?: number }) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getComplianceRules(params);
      if (res.success && res.data) {
        setRules(res.data.rules as ComplianceRule[]);
        setTotal(res.data.pagination?.total ?? res.data.rules.length);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch compliance rules');
    } finally {
      setLoading(false);
    }
  }, []);

  const createRule = useCallback(async (data: ComplianceRuleCreate): Promise<ComplianceRule | null> => {
    try {
      const res = await api.createComplianceRule(data as unknown as Record<string, unknown>);
      if (res.success && res.data) {
        const rule = (res.data as { rule: ComplianceRule }).rule;
        setRules((prev) => [rule, ...prev]);
        return rule;
      }
      return null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create rule');
      return null;
    }
  }, []);

  const updateRule = useCallback(async (id: string, data: ComplianceRuleUpdate): Promise<ComplianceRule | null> => {
    try {
      const res = await api.updateComplianceRule(id, data as unknown as Record<string, unknown>);
      if (res.success && res.data) {
        const rule = (res.data as { rule: ComplianceRule }).rule;
        setRules((prev) => prev.map((r) => (r.id === id ? rule : r)));
        return rule;
      }
      return null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update rule');
      return null;
    }
  }, []);

  const deleteRule = useCallback(async (id: string): Promise<boolean> => {
    try {
      await api.deleteComplianceRule(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete rule');
      return false;
    }
  }, []);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  return { rules, loading, error, total, fetchRules, createRule, updateRule, deleteRule };
}
