// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Trash2, Edit2, Activity, FileCode } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useFetch } from '@/hooks/useFetch';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/ui/EmptyState';
import { RetryError } from '@/components/ui/RetryError';
import { Pagination } from '@/components/ui/Pagination';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Checkbox } from '@/components/ui/Checkbox';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { RecentlyDeletedPanel } from '@/components/RecentlyDeletedPanel';
import { api } from '@/lib/api';
import type { AlertRule, AlertRuleWrite } from '@/types/observability';
import { formatError } from '@/lib/constants';

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
 * Viewing rules requires `observability:read` (Members hold it per the
 * catalog); authoring/editing/deleting requires `observability:write`, gated
 * per-control via `can()` (which also reports false under read-only
 * impersonation). Superadmins bypass.
 *
 * The list pages server-side (`?offset&limit`). System admins additionally get a
 * read-only preview of the materialized `rule_files` YAML — the exact document
 * Prometheus loads, across every org (hence sysadmin-only, like its route).
 */
/** Smallest page-size option — the pager only appears once there's more than this. */
const PAGE_SIZES = [10, 25, 50, 100];

export default function AlertRulesPage() {
  // View on `observability:read` (page-access, from the route declaration);
  // write controls gated on `observability:write`.
  const { accessDenied, isReady, isAuthenticated, can, isSuperAdmin } = useAuthGuard();
  const canWrite = can('observability:write');
  const toast = useToast();
  const ready = isReady && isAuthenticated;
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AlertRule | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(25);

  const { data, loading, error, refetch } = useFetch(
    async (signal) => {
      if (!ready) return null;
      return (await api.listAlertRules({ offset, limit }, signal)).data ?? null;
    },
    [ready, offset, limit],
  );
  const rules: AlertRule[] = data?.rules ?? [];
  const total = data?.pagination.total ?? 0;
  const refresh = async () => { refetch(); };

  // A delete can empty the last page — step back to the new last page rather
  // than render an empty list on a stale offset.
  useEffect(() => {
    if (data && offset > 0 && offset >= total) {
      setOffset(total === 0 ? 0 : Math.floor((total - 1) / limit) * limit);
    }
  }, [data, offset, total, limit]);

  const onDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.deleteAlertRule(deleting.id);
      toast.success('Alert rule deleted');
      setDeleting(null);
      await refresh();
    } catch (err) {
      toast.error(formatError(err));
    } finally {
      setDeleteBusy(false);
    }
  };

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !isAuthenticated) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Alert rules"
      subtitle="Operator-authored PromQL conditions that fire alerts for this org. Rules are auto-scoped to your org's metrics."
      actions={
        canWrite || isSuperAdmin ? (
          <div className="flex items-center gap-2">
            {isSuperAdmin && (
              <Button
                variant="secondary"
                size="xs"
                onClick={() => setPreviewing(true)}
                className="gap-1"
              >
                <FileCode className="w-3.5 h-3.5" /> Preview rendered rules
              </Button>
            )}
            {canWrite && (
              <Button
                variant="secondary"
                size="xs"
                onClick={() => setCreating(true)}
                className="gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Add rule
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Configure where these alerts get delivered on the{' '}
        <Link href="/dashboard/observability/alert-destinations" className="text-blue-600 hover:underline">Alert destinations page</Link>,
        or see what&apos;s currently firing on the{' '}
        <Link href="/dashboard/observability/alerts" className="text-blue-600 hover:underline">Alerts page</Link>.
      </div>

      {error && <RetryError message={error.message} onRetry={refetch} className="mb-4" />}

      {loading && !data ? (
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
      ) : error && !data ? null : rules.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No alert rules yet"
          description={canWrite
            ? <>Click <strong>Add rule</strong> above to author a PromQL condition (e.g. a build-failure rate) that fires alerts for your org.</>
            : 'No PromQL alert conditions have been authored for this org.'}
        />
      ) : (
        <>
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
              {canWrite && (
                <>
                  <IconButton
                    onClick={() => setEditing(r)}
                    aria-label="Edit rule"
                  >
                    <Edit2 className="w-4 h-4" />
                  </IconButton>
                  <IconButton
                    onClick={() => setDeleting(r)}
                    tone="danger"
                    aria-label="Delete rule"
                  >
                    <Trash2 className="w-4 h-4" />
                  </IconButton>
                </>
              )}
            </div>
          ))}
        </div>
        {total > PAGE_SIZES[0] && (
          <Pagination
            pagination={{ offset, limit, total }}
            onPageChange={setOffset}
            onPageSizeChange={(size) => { setLimit(size); setOffset(0); }}
            pageSizeOptions={PAGE_SIZES}
          />
        )}
        </>
      )}

      {/* Recently deleted — a deleted rule stays restorable until the retention
          sweep purges it, but that was invisible before this panel: the restore
          endpoint existed with nothing able to list what it could restore.
          Restore/purge are `observability:write` + step-up gated server-side, so
          the panel only appears for users who can actually use it. */}
      {canWrite && (
        <div className="mt-6">
          <RecentlyDeletedPanel resource="alert-rule" onRestored={() => void refresh()} />
        </div>
      )}

      {(creating || editing) && (
        <RuleModal
          existing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={async () => { await refresh(); setCreating(false); setEditing(null); }}
        />
      )}

      {previewing && <MaterializedRulesModal onClose={() => setPreviewing(false)} />}

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
 * Sysadmin read-only view of `GET /observability/alert-rules/materialized.yml`:
 * every org's enabled rules rendered into the Prometheus `rule_files` document
 * the config reloader pulls — what Prometheus will actually evaluate, org_id
 * matchers and labels included.
 */
function MaterializedRulesModal({ onClose }: { onClose: () => void }) {
  const { data: yaml, loading, error, refetch } = useFetch(
    (signal) => api.getMaterializedAlertRules(signal),
    [],
  );
  return (
    <Modal title="Rendered alert rules (all orgs)" onClose={onClose} maxWidth="max-w-3xl">
      {loading && yaml === null ? (
        <div className="h-40 skeleton rounded" />
      ) : error ? (
        <RetryError message={error.message} onRetry={refetch} />
      ) : (
        <div className="max-h-[60vh] overflow-auto">
          <CodeBlock code={yaml ?? ''} language="YAML" />
        </div>
      )}
    </Modal>
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
      toast.error(formatError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={existing ? 'Edit alert rule' : 'Add alert rule'} onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Name</label>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. High build failure rate"
          />
          <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">Letters, digits, space, _ or - (max 100 chars).</div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">PromQL expression</label>
          <Textarea
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            rows={3}
            placeholder={'rate(plugin_build_failures_total[5m]) > 0.1'}
            className="font-mono"
          />
          <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Your org&apos;s <code>org_id</code> matcher is injected automatically — write plain PromQL. The alert fires when the expression returns a result.
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">For (duration)</label>
            <Input
              type="text"
              value={forDuration}
              onChange={(e) => setForDuration(e.target.value)}
              placeholder="5m"
              className="font-mono"
            />
            <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">Prometheus syntax (e.g. 30s, 5m, 1h).</div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Severity</label>
            <Select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as typeof severity)}
            >
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </Select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Summary</label>
          <Input
            type="text"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="e.g. Build failure rate is elevated"
          />
          <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">Alertmanager annotation; supports <code>{'{{ $value }}'}</code> (max 500 chars).</div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Description (optional)</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Extra context shown alongside the firing alert."
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void onSubmit()}
            disabled={saving || !canSubmit}
          >
            {saving ? 'Saving…' : (existing ? 'Save' : 'Create')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
