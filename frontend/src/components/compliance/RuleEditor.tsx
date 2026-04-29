'use client';

import { useState } from 'react';
import { ArrowLeft, Plus, Trash2, FlaskConical, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import api from '@/lib/api';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import type { ComplianceRule, ComplianceRuleCreate, ComplianceRuleUpdate, RuleCondition, RuleTarget, RuleSeverity, RuleOperator, RuleConditionMode, RuleScope, ComplianceCheckResult } from '@/types/compliance';

const OPERATORS: { value: RuleOperator; label: string }[] = [
  { value: 'eq', label: 'Equals' },
  { value: 'neq', label: 'Not Equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'notContains', label: 'Not Contains' },
  { value: 'regex', label: 'Regex' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'in', label: 'In List' },
  { value: 'notIn', label: 'Not In List' },
  { value: 'exists', label: 'Exists' },
  { value: 'notExists', label: 'Not Exists' },
  { value: 'countGt', label: 'Count >' },
  { value: 'countLt', label: 'Count <' },
  { value: 'lengthGt', label: 'Length >' },
  { value: 'lengthLt', label: 'Length <' },
];

const NO_VALUE_OPS = new Set<string>(['exists', 'notExists']);

const safeStringify = (v: unknown): string => {
  try { return JSON.stringify(v); } catch { return String(v); }
};

interface RuleEditorProps {
  rule?: ComplianceRule;
  onSave: (rule: ComplianceRule) => void;
  onCancel: () => void;
}

interface FormState {
  name: string;
  description: string;
  target: RuleTarget;
  scope: RuleScope;
  severity: RuleSeverity;
  priority: number;
  tags: string;
  suppressNotification: boolean;
  effectiveFrom: string;
  effectiveUntil: string;
  useConditions: boolean;
  field: string;
  operator: RuleOperator;
  value: string;
  conditionMode: RuleConditionMode;
  conditions: { field: string; operator: RuleOperator; value: string }[];
}

function ruleToForm(rule?: ComplianceRule): FormState {
  if (!rule) {
    return {
      name: '', description: '', target: 'plugin', scope: 'org', severity: 'warning', priority: 0,
      tags: '', suppressNotification: false, effectiveFrom: '', effectiveUntil: '',
      useConditions: false, field: '', operator: 'eq', value: '',
      conditionMode: 'all', conditions: [],
    };
  }
  const hasConditions = (rule.conditions?.length ?? 0) > 0;
  return {
    name: rule.name,
    description: rule.description || '',
    target: rule.target,
    scope: rule.scope,
    severity: rule.severity,
    priority: rule.priority,
    tags: (rule.tags || []).join(', '),
    suppressNotification: rule.suppressNotification,
    effectiveFrom: rule.effectiveFrom?.slice(0, 10) || '',
    effectiveUntil: rule.effectiveUntil?.slice(0, 10) || '',
    useConditions: hasConditions,
    field: rule.field || '',
    operator: rule.operator || 'eq',
    value: rule.value != null ? safeStringify(rule.value) : '',
    conditionMode: rule.conditionMode || 'all',
    conditions: hasConditions
      ? rule.conditions!.map(c => ({ field: c.field, operator: c.operator, value: c.value != null ? safeStringify(c.value) : '' }))
      : [],
  };
}

function parseValue(str: string): unknown {
  if (!str) return undefined;
  try { return JSON.parse(str); } catch { return str; }
}

export default function RuleEditor({ rule, onSave, onCancel }: RuleEditorProps) {
  const { isSysAdmin } = useAuthGuard();
  const [form, setForm] = useState<FormState>(() => ruleToForm(rule));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<ComplianceCheckResult | null>(null);
  const [dryRunAttrs, setDryRunAttrs] = useState('{}');

  const isEdit = !!rule;

  const set = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm(f => ({ ...f, [key]: val }));

  const addCondition = () =>
    set('conditions', [...form.conditions, { field: '', operator: 'eq' as RuleOperator, value: '' }]);

  const removeCondition = (idx: number) =>
    set('conditions', form.conditions.filter((_, i) => i !== idx));

  const updateCondition = (idx: number, patch: Partial<{ field: string; operator: RuleOperator; value: string }>) =>
    set('conditions', form.conditions.map((c, i) => i === idx ? { ...c, ...patch } : c));

  const handleSubmit = async () => {
    if (!form.name || !form.target) { setError('Name and target are required.'); return; }

    setSaving(true);
    setError(null);
    try {
      const tags = form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      const conditions: RuleCondition[] | undefined = form.useConditions && form.conditions.length > 0
        ? form.conditions.map(c => ({
          field: c.field, operator: c.operator,
          ...(NO_VALUE_OPS.has(c.operator) ? {} : { value: parseValue(c.value) }),
        }))
        : undefined;

      if (isEdit) {
        const data: ComplianceRuleUpdate = {
          name: form.name,
          description: form.description || undefined,
          severity: form.severity,
          priority: form.priority,
          tags,
          suppressNotification: form.suppressNotification,
          effectiveFrom: form.effectiveFrom || null,
          effectiveUntil: form.effectiveUntil || null,
          conditionMode: form.useConditions ? form.conditionMode : undefined,
          conditions,
          ...(!form.useConditions ? {
            field: form.field || undefined,
            operator: form.operator,
            value: parseValue(form.value),
          } : {}),
        };
        const res = await api.updateComplianceRule(rule!.id, data);
        if (res.success && res.data) onSave(res.data.rule);
        else setError('Failed to update rule');
      } else {
        const data: ComplianceRuleCreate = {
          name: form.name,
          description: form.description || undefined,
          target: form.target,
          scope: isSysAdmin ? form.scope : undefined,
          severity: form.severity,
          priority: form.priority,
          tags,
          suppressNotification: form.suppressNotification,
          effectiveFrom: form.effectiveFrom || undefined,
          effectiveUntil: form.effectiveUntil || undefined,
          conditionMode: form.useConditions ? form.conditionMode : undefined,
          conditions,
          ...(!form.useConditions ? {
            field: form.field || undefined,
            operator: form.operator,
            value: parseValue(form.value),
          } : {}),
        };
        const res = await api.createComplianceRule(data);
        if (res.success && res.data) onSave(res.data.rule);
        else setError('Failed to create rule');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
    setSaving(false);
  };

  const handleDryRun = async () => {
    setDryRunResult(null);
    try {
      const attrs = JSON.parse(dryRunAttrs);
      const fn = form.target === 'pipeline' ? api.dryRunPipelineCompliance : api.dryRunPluginCompliance;
      const res = await fn.call(api, attrs);
      if (res.success && res.data) setDryRunResult(res.data);
    } catch { setError('Invalid JSON for dry-run attributes'); }
  };

  const inputCls = 'rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm w-full';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={onCancel} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          {isEdit ? 'Edit Rule' : 'Create Rule'}
        </h2>
      </div>

      {error && <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">{error}</div>}

      <div className="space-y-4 p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        {/* Basic info */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Name *</label>
            <input value={form.name} onChange={e => set('name', e.target.value)} className={inputCls} placeholder="Rule name" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Target *</label>
            <select value={form.target} onChange={e => set('target', e.target.value as RuleTarget)} className={inputCls} disabled={isEdit}>
              <option value="plugin">Plugin</option>
              <option value="pipeline">Pipeline</option>
            </select>
          </div>
        </div>
        {isSysAdmin && (
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Scope</label>
            <select value={form.scope} onChange={e => set('scope', e.target.value as RuleScope)} className={inputCls} disabled={isEdit}>
              <option value="org">Org — private to your organization</option>
              <option value="published">Published — shared catalog, other orgs can subscribe</option>
            </select>
            {isEdit && <p className="mt-1 text-xs text-gray-500">Scope is set at creation and cannot be changed.</p>}
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Description</label>
          <textarea value={form.description} onChange={e => set('description', e.target.value)} className={inputCls} rows={2} placeholder="Optional description" />
        </div>

        {/* Severity, priority, tags */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Severity</label>
            <select value={form.severity} onChange={e => set('severity', e.target.value as RuleSeverity)} className={inputCls}>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Priority</label>
            <input type="number" value={form.priority} onChange={e => set('priority', parseInt(e.target.value) || 0)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Tags (comma-separated)</label>
            <input value={form.tags} onChange={e => set('tags', e.target.value)} className={inputCls} placeholder="security, naming" />
          </div>
        </div>

        {/* Date range & notification */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Effective From</label>
            <input type="date" value={form.effectiveFrom} onChange={e => set('effectiveFrom', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Effective Until</label>
            <input type="date" value={form.effectiveUntil} onChange={e => set('effectiveUntil', e.target.value)} className={inputCls} />
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={form.suppressNotification} onChange={e => set('suppressNotification', e.target.checked)} className="rounded border-gray-300" />
              Suppress Notification
            </label>
          </div>
        </div>

        {/* Rule mode toggle */}
        <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
          <div className="flex items-center gap-4 mb-3">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Rule Mode:</label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="radio" checked={!form.useConditions} onChange={() => set('useConditions', false)} className="text-blue-600" />
              Single Field
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="radio" checked={form.useConditions} onChange={() => set('useConditions', true)} className="text-blue-600" />
              Multi-Condition
            </label>
          </div>

          {!form.useConditions ? (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Field</label>
                <input value={form.field} onChange={e => set('field', e.target.value)} className={inputCls} placeholder="e.g. name, computeType" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Operator</label>
                <select value={form.operator} onChange={e => set('operator', e.target.value as RuleOperator)} className={inputCls}>
                  {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              {!NO_VALUE_OPS.has(form.operator) && (
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Value (JSON)</label>
                  <input value={form.value} onChange={e => set('value', e.target.value)} className={inputCls} placeholder='"required-prefix"' />
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <label className="text-xs font-medium text-gray-500">Match:</label>
                <select value={form.conditionMode} onChange={e => set('conditionMode', e.target.value as RuleConditionMode)} className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm">
                  <option value="all">ALL conditions (AND)</option>
                  <option value="any">ANY condition (OR)</option>
                </select>
                <button onClick={addCondition} className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                  <Plus className="h-3 w-3" /> Add Condition
                </button>
              </div>
              {form.conditions.length === 0 && (
                <div className="text-center py-4 text-sm text-gray-400">No conditions yet. Click &quot;Add Condition&quot; to start.</div>
              )}
              {form.conditions.map((cond, idx) => (
                <div key={idx} className="flex items-center gap-2 p-2 rounded-lg bg-gray-50 dark:bg-gray-800">
                  <input
                    value={cond.field}
                    onChange={e => updateCondition(idx, { field: e.target.value })}
                    className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1.5 text-sm flex-1"
                    placeholder="Field"
                  />
                  <select
                    value={cond.operator}
                    onChange={e => updateCondition(idx, { operator: e.target.value as RuleOperator })}
                    className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1.5 text-sm"
                  >
                    {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  {!NO_VALUE_OPS.has(cond.operator) && (
                    <input
                      value={cond.value}
                      onChange={e => updateCondition(idx, { value: e.target.value })}
                      className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1.5 text-sm flex-1"
                      placeholder="Value (JSON)"
                    />
                  )}
                  <button onClick={() => removeCondition(idx)} className="p-1 text-gray-400 hover:text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Dry-run validation */}
        <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
          <div className="flex items-center gap-2 mb-2">
            <FlaskConical className="h-4 w-4 text-indigo-600" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Dry-Run Validation</span>
          </div>
          <div className="flex gap-2">
            <textarea
              value={dryRunAttrs}
              onChange={e => setDryRunAttrs(e.target.value)}
              className={`${inputCls} flex-1 font-mono`}
              rows={2}
              placeholder='{"name": "my-plugin", "computeType": "LAMBDA"}'
            />
            <button onClick={handleDryRun} className="self-end px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
              Test
            </button>
          </div>
          {dryRunResult && (
            <div className="mt-2 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 text-sm">
              <div className="flex items-center gap-4 mb-2">
                <span className="flex items-center gap-1">
                  {dryRunResult.passed ? <CheckCircle className="h-4 w-4 text-green-600" /> : <XCircle className="h-4 w-4 text-red-600" />}
                  {dryRunResult.passed ? 'Passed' : 'Failed'}
                </span>
                <span className="text-xs text-gray-500">{dryRunResult.rulesEvaluated} rules evaluated</span>
              </div>
              {dryRunResult.violations.length > 0 && (
                <div className="space-y-1">
                  {dryRunResult.violations.map((v, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <XCircle className="h-3 w-3 text-red-500 shrink-0" />
                      <span className="text-red-700 dark:text-red-400">{v.ruleName}: {v.message}</span>
                    </div>
                  ))}
                </div>
              )}
              {dryRunResult.warnings.length > 0 && (
                <div className="space-y-1 mt-1">
                  {dryRunResult.warnings.map((w, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <AlertTriangle className="h-3 w-3 text-yellow-500 shrink-0" />
                      <span className="text-yellow-700 dark:text-yellow-400">{w.ruleName}: {w.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button onClick={handleSubmit} disabled={saving} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
          {saving ? 'Saving...' : isEdit ? 'Update Rule' : 'Create Rule'}
        </button>
        <button onClick={onCancel} className="px-4 py-2 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg">
          Cancel
        </button>
      </div>
    </div>
  );
}
