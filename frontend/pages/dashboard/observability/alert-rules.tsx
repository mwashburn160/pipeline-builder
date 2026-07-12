// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import { Bell, Plus, Trash2, Edit2, Activity } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { api, ApiError } from '@/lib/api';
import type { AlertRule, AlertRuleWrite } from '@/types/observability';

/**
 * Per-org alert *rules* authoring page.
 *
 * Rules define *what fires* (an operator-authored PromQL condition); the
 * companion "Alert destinations" page defines *where alerts go*. Enabled rules
 * are materialized across all orgs into a Prometheus `rule_files` document; a
 * firing rule carries the org's `org_id` label so the alertmanager-relay routes
 * it to this org's destinations.
 *
 * The backend auto-injects an `org_id="<orgId>"` matcher into every metric
 * selector and rejects cross-tenant / malformed PromQL with a 400 — so this UI
 * lets operators write vanilla PromQL and surfaces the server's error message
 * verbatim.
 *
 * Mutations require `observability:write` (superadmins bypass); the whole page
 * is gated on it via `useAuthGuard`.
 */
export default function AlertRulesPage() {
  // Authoring alert rules is an `observability:write` capability. Gating the
  // whole page matches the sibling Alerts (triage) page.
  const { isReady, isAuthenticated } = useAuthGuard({ requirePermission: 'observability:write' });
  const toast = useToast();
  const ready = isReady && isAuthenticated;
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AlertRule | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const { data, loading, error, refetch } = useFetch(
    async () => {
      if (!ready) return [] as AlertRule[];
      const res = await api.listAlertRules();
      return res.data?.rules ?? [];
    },
    [ready],
  );
  const rules: AlertRule[] = data ?? [];
  const refresh = async () => { refetch(); };

  const onDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.deleteAlertRule(deleting.id);
      toast.success('Alert rule deleted');
      setDeleting(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  };

  if (!isReady || !isAuthenticated) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Alert rules"
      subtitle="Operator-authored PromQL conditions that fire alerts for this org. Rules are auto-scoped to your org's metrics."
      actions={
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <Plus className="w-3.5 h-3.5" /> Add rule
        </button>
      }
    >
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Configure where these alerts get delivered on the{' '}
        <Link href="/dashboard/observability/alert-destinations" className="text-blue-600 hover:underline">Alert destinations page</Link>,
        or see what&apos;s currently firing on the{' '}
        <Link href="/dashboard/observability/alerts" className="text-blue-600 hover:underline">Alerts page</Link>.
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200">
          {error.message}
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="px-4 py-3 flex items-center gap-3">
              <div className="w-5 h-5 skeleton rounded" />
              <div className="flex-1">
                <div className="h-4 skeleton w-1/3 mb-1.5" />
                <div className="h-3 skeleton w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : rules.length === 0 ? (
        <div className="rounded border border-gray-200 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
          No alert rules yet. Click <strong>Add rule</strong> above to author a PromQL condition (e.g. a build-failure rate) that fires alerts for your org.
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {rules.map((r) => (
            <div key={r.id} className="px-4 py-3 flex items-center gap-3">
              <Activity className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{r.name}</span>
                  <Badge color={r.severity === 'critical' ? 'red' : 'yellow'}>{r.severity}</Badge>
                  <Badge color="gray">for {r.forDuration}</Badge>
                  {!r.enabled && <Badge color="gray">disabled</Badge>}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 font-mono truncate" title={r.expr}>
                  {r.expr}
                </div>
                {r.summary && (
                  <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 truncate">{r.summary}</div>
                )}
              </div>
              <button
                onClick={() => setEditing(r)}
                aria-label="Edit rule"
                className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              >
                <Edit2 className="w-4 h-4" />
              </button>
              <button
                onClick={() => setDeleting(r)}
                aria-label="Delete rule"
                className="p-1 text-red-500 hover:text-red-700"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <RuleModal
          existing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={async () => { await refresh(); setCreating(false); setEditing(null); }}
        />
      )}

      {deleting && (
        <DeleteConfirmModal
          title="Delete alert rule"
          itemName={deleting.name}
          loading={deleteBusy}
          onConfirm={() => void onDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </DashboardLayout>
  );
}

/**
 * Create / edit modal. Operators write vanilla PromQL — the backend injects
 * the `org_id` matcher and returns a 400 (surfaced here as a toast) on any
 * malformed expression, cross-tenant matcher, or invalid `for:` duration.
 */
function RuleModal(props: {
  existing: AlertRule | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { existing, onClose, onSaved } = props;
  const toast = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [expr, setExpr] = useState(existing?.expr ?? '');
  const [forDuration, setForDuration] = useState(existing?.forDuration ?? '5m');
  const [severity, setSeverity] = useState<'warning' | 'critical'>(existing?.severity ?? 'warning');
  const [summary, setSummary] = useState(existing?.summary ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const canSubmit = name.trim() && expr.trim() && summary.trim();

  const onSubmit = async () => {
    if (!name.trim()) { toast.error('Name is required'); return; }
    if (!expr.trim()) { toast.error('PromQL expression is required'); return; }
    if (!summary.trim()) { toast.error('Summary is required'); return; }
    setSaving(true);
    try {
      const body: AlertRuleWrite = {
        name: name.trim(),
        expr: expr.trim(),
        forDuration: forDuration.trim() || '5m',
        severity,
        summary: summary.trim(),
        description: description.trim(),
        enabled,
      };
      if (existing) {
        await api.updateAlertRule(existing.id, body);
        toast.success('Alert rule updated');
      } else {
        await api.createAlertRule(body);
        toast.success('Alert rule created');
      }
      await onSaved();
    } catch (err) {
      // The backend returns a descriptive 400 for PromQL / tenancy / duration
      // validation failures; surface it verbatim so operators can fix the expr.
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={existing ? 'Edit alert rule' : 'Add alert rule'} onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. High build failure rate"
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
          />
          <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">Letters, digits, space, _ or - (max 100 chars).</div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">PromQL expression</label>
          <textarea
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            rows={3}
            placeholder={'rate(plugin_build_failures_total[5m]) > 0.1'}
            className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
          />
          <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Your org&apos;s <code>org_id</code> matcher is injected automatically — write plain PromQL. The alert fires when the expression returns a result.
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">For (duration)</label>
            <input
              type="text"
              value={forDuration}
              onChange={(e) => setForDuration(e.target.value)}
              placeholder="5m"
              className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
            />
            <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">Prometheus syntax (e.g. 30s, 5m, 1h).</div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Severity</label>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as typeof severity)}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
            >
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Summary</label>
          <input
            type="text"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="e.g. Build failure rate is elevated"
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
          />
          <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">Alertmanager annotation; supports <code>{'{{ $value }}'}</code> (max 500 chars).</div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Description (optional)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Extra context shown alongside the firing alert."
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={saving} className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded">
            Cancel
          </button>
          <button
            onClick={() => void onSubmit()}
            disabled={saving || !canSubmit}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded disabled:opacity-50"
          >
            {saving ? 'Saving…' : (existing ? 'Save' : 'Create')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
