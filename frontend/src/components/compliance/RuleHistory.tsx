'use client';

import { History, ArrowLeft } from 'lucide-react';
import { TextEmptyState } from '@/components/ui/EmptyState';
import { RetryError } from '@/components/ui/RetryError';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import type { ComplianceRuleHistoryEntry } from '@/types/compliance';
import { formatDateTime } from '@/lib/format';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Badge, type BadgeColor } from '@/components/ui/Badge';

const CHANGE_COLOR: Record<string, BadgeColor> = {
  created: 'green',
  updated: 'blue',
  deleted: 'red',
  restored: 'purple',
};

interface RuleHistoryProps {
  ruleId: string;
  ruleName: string;
  onBack: () => void;
}

export default function RuleHistory({ ruleId, ruleName, onBack }: RuleHistoryProps) {
  // A rule switch supersedes the in-flight read, so an older response can't
  // overwrite the current rule's history.
  const { data, loading, error, refetch } = useFetch<ComplianceRuleHistoryEntry[]>(async () => {
    let res: Awaited<ReturnType<typeof api.getComplianceRuleHistory>>;
    try {
      res = await api.getComplianceRuleHistory(ruleId);
    } catch {
      throw new Error('Failed to load rule history');
    }
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load rule history');
    return res.data.history;
  }, [ruleId]);
  const history = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg text-fg-subtle hover:text-fg hover:bg-surface-muted transition-colors"
          aria-label="Go back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <History className="h-5 w-5 text-brand" />
        <h2 className="text-lg font-semibold text-fg">
          History: {ruleName}
        </h2>
      </div>

      {error && !loading && <RetryError message={error.message} onRetry={() => void refetch()} />}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner label="Loading rule history" />
        </div>
      ) : history.length === 0 ? (
        <TextEmptyState>No history entries found.</TextEmptyState>
      ) : (
        <div className="space-y-3">
          {history.map(entry => {
            const changeColor = CHANGE_COLOR[entry.changeType] || CHANGE_COLOR.updated;
            return (
              <div key={entry.id} className="p-4 rounded-lg border border-default bg-surface">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <Badge color={changeColor}>{entry.changeType}</Badge>
                    <span className="text-xs text-fg-muted">
                      by {entry.changedBy}
                    </span>
                  </div>
                  <span className="text-xs text-fg-subtle">
                    {formatDateTime(entry.changedAt)}
                  </span>
                </div>
                {entry.previousState && Object.keys(entry.previousState).length > 0 && (
                  <div className="mt-2 p-2 rounded bg-surface-muted text-xs font-mono text-fg-muted overflow-x-auto">
                    <div className="text-fg-subtle mb-1">Previous state:</div>
                    {Object.entries(entry.previousState).map(([key, val]) => (
                      <div key={key}>
                        <span className="text-fg-subtle">{key}:</span> {JSON.stringify(val)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
