'use client';

import type { BadgeColor } from '@/components/ui/Badge';
import { useState, useEffect } from 'react';
import { Sparkles, Check } from 'lucide-react';
import api from '@/lib/api';
import type { RuleTemplate } from '@/types/compliance';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingSpinner } from '@/components/ui/Loading';


const CATEGORY_COLORS: Record<string, BadgeColor> = {
  security: 'red',
  quality: 'blue',
  convention: 'purple',
  cost: 'green',
};

/** Tooltip on a disabled Apply. `readOnly` covers both a missing
 *  `compliance:write` and a read-only impersonation session, so it names neither. */
export const APPLY_BLOCKED_REASON = "You don't have permission to add compliance rules";

interface TemplateOnboardingProps {
  /** Disables Apply — the caller lacks `compliance:write` (or is in a read-only session). */
  readOnly?: boolean;
}

export default function TemplateOnboarding({ readOnly = false }: TemplateOnboardingProps) {
  const [templates, setTemplates] = useState<RuleTemplate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);

  useEffect(() => {
    api.getRuleTemplates().then(res => {
      if (res.success && res.data) {
        setTemplates(res.data.templates);
        // Opt-in by default: org admin must explicitly tick what they want before
        // Apply enrolls them — pre-selecting every template would make it easy
        // to accept the entire system catalog with one click.
      } else {
        setError(res.message || 'Failed to load rule templates');
      }
    }).catch(() => setError('Failed to load rule templates')).finally(() => setLoading(false));
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
    if (readOnly || selectedIds.size === 0) return;
    setApplying(true);
    setError(null);
    try {
      const res = await api.applyRuleTemplates([...selectedIds]);
      if (res.success && res.data) setResult(res.data);
      else setError(res.message || 'Failed to apply templates');
    } catch {
      setError('Failed to apply templates');
    }
    setApplying(false);
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><LoadingSpinner label="Loading rule templates" /></div>;
  }

  if (result) {
    return (
      <Callout variant="success" icon={Check} title="Templates applied">
        {result.created} rule{result.created !== 1 ? 's' : ''} created
        {result.skipped > 0 && `, ${result.skipped} skipped (already exist)`}
      </Callout>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-warning" />
          <h2 className="text-lg font-semibold text-fg">Starter rule templates</h2>
        </div>
        <Button
          onClick={handleApply}
          loading={applying}
          disabled={readOnly || selectedIds.size === 0}
          title={readOnly ? APPLY_BLOCKED_REASON : undefined}
          className="gap-1.5"
        >
          {!applying && <Sparkles className="h-4 w-4" />}
          Apply {selectedIds.size} Template{selectedIds.size !== 1 ? 's' : ''}
        </Button>
      </div>

      <ErrorAlert message={error} onDismiss={() => setError(null)} />

      <p className="text-sm text-fg-muted">
        Select starter rules to add to your organization. These create org-scoped rules you can customize.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {templates.map(t => {
          const selected = selectedIds.has(t.id);
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={selected}
              onClick={() => toggleTemplate(t.id)}
              className={`text-left p-4 rounded-lg border-2 transition-colors ${
                selected
                  ? 'border-blue-500 bg-info-bg'
                  : 'border-default bg-surface hover:border-default'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-fg">{t.name}</span>
                    <Badge color={CATEGORY_COLORS[t.category] ?? 'gray'}>{t.category}</Badge>
                  </div>
                  <p className="text-xs text-fg-muted">{t.description}</p>
                  <div className="flex gap-2 mt-2">
                    <Badge color="gray">{t.target}</Badge>
                    <Badge color="gray">{t.severity}</Badge>
                  </div>
                </div>
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${selected ? 'bg-brand border-brand' : 'border-default'}`}>
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
