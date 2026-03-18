'use client';

import { useState, useEffect } from 'react';
import { Sparkles, Check, Loader2 } from 'lucide-react';
import api from '@/lib/api';
import type { RuleTemplate } from '@/types/compliance';

const CATEGORY_COLORS: Record<string, string> = {
  security: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  quality: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
  convention: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400',
  cost: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
};

export default function TemplateOnboarding() {
  const [templates, setTemplates] = useState<RuleTemplate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);

  useEffect(() => {
    api.getRuleTemplates().then(res => {
      if (res.success && res.data) {
        setTemplates(res.data.templates);
        setSelectedIds(new Set(res.data.templates.map(t => t.id)));
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const toggleTemplate = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleApply = async () => {
    if (selectedIds.size === 0) return;
    setApplying(true);
    try {
      const res = await api.applyRuleTemplates([...selectedIds]);
      if (res.success && res.data) setResult(res.data);
    } catch { /* handled */ }
    setApplying(false);
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-blue-600" /></div>;
  }

  if (result) {
    return (
      <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-6 text-center">
        <Check className="h-10 w-10 text-green-600 mx-auto mb-3" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Templates Applied</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {result.created} rule{result.created !== 1 ? 's' : ''} created
          {result.skipped > 0 && `, ${result.skipped} skipped (already exist)`}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-amber-500" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Starter Rule Templates</h2>
        </div>
        <button
          onClick={handleApply}
          disabled={applying || selectedIds.size === 0}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Apply {selectedIds.size} Template{selectedIds.size !== 1 ? 's' : ''}
        </button>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        Select starter rules to add to your organization. These create org-scoped rules you can customize.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {templates.map(t => {
          const selected = selectedIds.has(t.id);
          return (
            <button
              key={t.id}
              onClick={() => toggleTemplate(t.id)}
              className={`text-left p-4 rounded-lg border-2 transition-colors ${
                selected
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-600'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{t.name}</span>
                    <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${CATEGORY_COLORS[t.category] || 'bg-gray-100 text-gray-600'}`}>
                      {t.category}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{t.description}</p>
                  <div className="flex gap-2 mt-2">
                    <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded px-1.5 py-0.5">{t.target}</span>
                    <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded px-1.5 py-0.5">{t.severity}</span>
                  </div>
                </div>
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${selected ? 'bg-blue-600 border-blue-600' : 'border-gray-300 dark:border-gray-600'}`}>
                  {selected && <Check className="h-3 w-3 text-white" />}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
