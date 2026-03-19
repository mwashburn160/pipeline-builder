'use client';

import { useState, useEffect, useCallback } from 'react';
import { History, ArrowLeft, Loader2 } from 'lucide-react';
import api from '@/lib/api';
import type { ComplianceRuleHistoryEntry } from '@/types/compliance';

const CHANGE_STYLES: Record<string, { bg: string; text: string }> = {
  created: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  updated: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400' },
  deleted: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400' },
  restored: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-400' },
};

interface RuleHistoryProps {
  ruleId: string;
  ruleName: string;
  onBack: () => void;
}

export default function RuleHistory({ ruleId, ruleName, onBack }: RuleHistoryProps) {
  const [history, setHistory] = useState<ComplianceRuleHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getComplianceRuleHistory(ruleId);
      if (res.success && res.data) setHistory(res.data.history);
    } catch { /* handled by loading state */ }
    setLoading(false);
  }, [ruleId]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          aria-label="Go back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <History className="h-5 w-5 text-blue-600" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          History: {ruleName}
        </h2>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      ) : history.length === 0 ? (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">No history entries found.</div>
      ) : (
        <div className="space-y-3">
          {history.map(entry => {
            const style = CHANGE_STYLES[entry.changeType] || CHANGE_STYLES.updated;
            return (
              <div key={entry.id} className="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${style.bg} ${style.text}`}>
                      {entry.changeType}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      by {entry.changedBy}
                    </span>
                  </div>
                  <span className="text-xs text-gray-400">
                    {new Date(entry.changedAt).toLocaleString()}
                  </span>
                </div>
                {entry.previousState && Object.keys(entry.previousState).length > 0 && (
                  <div className="mt-2 p-2 rounded bg-gray-50 dark:bg-gray-800 text-xs font-mono text-gray-600 dark:text-gray-400 overflow-x-auto">
                    <div className="text-gray-500 dark:text-gray-500 mb-1">Previous state:</div>
                    {Object.entries(entry.previousState).map(([key, val]) => (
                      <div key={key}>
                        <span className="text-gray-400">{key}:</span> {JSON.stringify(val)}
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
