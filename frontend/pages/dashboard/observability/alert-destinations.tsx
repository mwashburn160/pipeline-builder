// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
// lucide-react v1 removed brand icons (e.g. Slack); use a generic messaging glyph.
import { Bell, Plus, Trash2, Edit2, MessageSquare, Webhook, Mail, Bell as BellIcon } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { CopyableId } from '@/components/ui/CopyableId';
import { api, ApiError } from '@/lib/api';
import type { AlertDestination, AlertDestinationWrite } from '@/types/observability';

/**
 * Per-org alert destinations settings page.
 *
 * Multi-tenant alerting routes Alertmanager webhooks to the platform's
 * alert-relay, which looks up destinations here for the firing alert's
 * `org_id` label and fans out to each one. Operators register their Slack
 * incoming-webhook URLs (or generic HTTPS webhooks, or opt into in-app)
 * here; the platform never logs or returns the raw target back — only a
 * masked `••••XXXX` preview.
 */
export default function AlertDestinationsPage() {
  const { isReady, isAuthenticated, isSuperAdmin } = useAuthGuard();
  const toast = useToast();
  const ready = isReady && isAuthenticated;
  const [editing, setEditing] = useState<AlertDestination | null>(null);
  const [creating, setCreating] = useState(false);
  // Sysadmin cross-tenant view (read-only) — folds in the former
  // /dashboard/admin/alert-destinations page.
  const [allOrgs, setAllOrgs] = useState(false);
  const viewingAll = allOrgs && isSuperAdmin;
  // Deep-link: `?all=1` opens the cross-tenant view for sysadmins (used by the
  // sysadmin home and the old /admin/alert-destinations redirect).
  const router = useRouter();
  useEffect(() => {
    if (router.isReady && router.query.all === '1' && isSuperAdmin) setAllOrgs(true);
  }, [router.isReady, router.query.all, isSuperAdmin]);
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState<'all' | 'slack' | 'webhook' | 'in-app' | 'email'>('all');

  const { data, loading, error, refetch } = useFetch(
    async () => {
      if (!ready) return [] as AlertDestination[];
      const res = viewingAll
        ? await api.listAlertDestinations({ all: true })
        : await api.listAlertDestinations();
      return res.data?.destinations ?? [];
    },
    [ready, viewingAll],
  );
  const destinations: AlertDestination[] = data ?? [];
  const refresh = async () => { refetch(); };

  const onDelete = async (d: AlertDestination) => {
    if (!confirm(`Delete destination "${d.label}"?`)) return;
    try {
      await api.deleteAlertDestination(d.id);
      toast.success('Destination deleted');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  // Cross-tenant view: group by org, with search + channel filters.
  const grouped = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = destinations.filter((d) => {
      if (channelFilter !== 'all' && d.channel !== channelFilter) return false;
      if (!term) return true;
      return (d.orgId ?? '').toLowerCase().includes(term) || d.label.toLowerCase().includes(term);
    });
    const map = new Map<string, AlertDestination[]>();
    for (const d of filtered) {
      const key = d.orgId ?? '(unknown)';
      const items = map.get(key) ?? [];
      items.push(d);
      map.set(key, items);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [destinations, search, channelFilter]);

  if (!isReady || !isAuthenticated) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Alert destinations"
      subtitle={viewingAll
        ? 'Cross-tenant view — read-only. Destinations are owned by each org’s admins.'
        : "Where this org's alerts go: Slack webhooks, generic HTTPS webhooks, or in-app messages."}
      titleExtra={viewingAll ? <Badge color="red">System Admin</Badge> : undefined}
      actions={
        <div className="flex items-center gap-2">
          {isSuperAdmin && (
            <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400" title="View every org's destinations (read-only)">
              <input type="checkbox" checked={allOrgs} onChange={(e) => setAllOrgs(e.target.checked)} className="rounded border-gray-300" />
              All organizations
            </label>
          )}
          {!viewingAll && (
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <Plus className="w-3.5 h-3.5" /> Add destination
            </button>
          )}
        </div>
      }
    >
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        See current firing alerts on the <Link href="/dashboard/observability/alerts" className="text-blue-600 hover:underline">Alerts page</Link>.
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200">
          {error.message}
        </div>
      )}

      {viewingAll ? (
        /* ───── Sysadmin cross-tenant view (read-only, grouped by org) ───── */
        <>
          <div className="filter-bar flex flex-wrap items-center gap-2 mb-4">
            <input
              type="text"
              placeholder="Filter by org id or label..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="filter-input flex-1 min-w-[16rem]"
            />
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value as typeof channelFilter)}
              className="filter-select"
              aria-label="Filter by channel"
            >
              <option value="all">All channels</option>
              <option value="slack">Slack</option>
              <option value="webhook">Webhook</option>
              <option value="in-app">In-app</option>
              <option value="email">Email</option>
            </select>
          </div>
          {loading ? (
            <div className="card py-10 text-center text-sm text-gray-500 dark:text-gray-400">Loading…</div>
          ) : grouped.length === 0 ? (
            <div className="card py-10 text-center text-sm text-gray-500 dark:text-gray-400">
              <Bell className="w-8 h-8 mx-auto mb-2 opacity-50" /> No destinations match the current filters.
            </div>
          ) : (
            <div className="space-y-3">
              {grouped.map(([orgId, items]) => (
                <div key={orgId} className="card">
                  <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-200 dark:border-gray-700">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Org:</span>
                      <CopyableId value={orgId} size="sm" />
                    </div>
                    <Link href={`/dashboard/admin/orgs/${orgId}`} className="action-link text-xs">Open org detail</Link>
                  </div>
                  <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                    {items.map((d) => (
                      <li key={d.id} className="py-2 flex flex-wrap items-baseline gap-2 text-sm">
                        <Badge color={d.channel === 'slack' ? 'purple' : d.channel === 'webhook' ? 'blue' : d.channel === 'email' ? 'green' : 'gray'}>{d.channel}</Badge>
                        <span className="font-medium text-gray-900 dark:text-gray-100">{d.label}</span>
                        <Badge color={d.minSeverity === 'critical' ? 'red' : 'yellow'}>{d.minSeverity}</Badge>
                        {!d.enabled && <Badge color="gray">disabled</Badge>}
                        {d.hasTarget && <code className="text-xs text-gray-500 dark:text-gray-400 ml-auto">{d.target}</code>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <div className="mt-6 text-xs text-gray-500 dark:text-gray-400">
            Read-only across orgs — targets are masked even for sysadmins. Turn off
            “All organizations” to manage your own org&apos;s destinations.
          </div>
        </>
      ) : (
        /* ───── Org-scoped editable view ───── */
        loading ? (
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
        ) : destinations.length === 0 ? (
          <div className="rounded border border-gray-200 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            No destinations configured yet. Click <strong>Add destination</strong> above to start receiving alerts in Slack.
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {destinations.map((d) => (
              <div key={d.id} className="px-4 py-3 flex items-center gap-3">
                <ChannelIcon channel={d.channel} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{d.label}</span>
                    {!d.enabled && <Badge color="gray">disabled</Badge>}
                    <Badge color={d.minSeverity === 'critical' ? 'red' : 'yellow'}>≥ {d.minSeverity}</Badge>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 font-mono">
                    {d.channel === 'in-app' ? '(in-app messages)' : (d.hasTarget ? d.target : '— no target set —')}
                  </div>
                </div>
                <button
                  onClick={() => setEditing(d)}
                  aria-label="Edit destination"
                  className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => void onDelete(d)}
                  aria-label="Delete destination"
                  className="p-1 text-red-500 hover:text-red-700"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )
      )}

      {(creating || editing) && (
        <DestinationModal
          existing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={async () => { await refresh(); setCreating(false); setEditing(null); }}
        />
      )}
    </DashboardLayout>
  );
}

function ChannelIcon({ channel }: { channel: AlertDestination['channel'] }) {
  if (channel === 'slack') return <MessageSquare className="w-5 h-5 text-purple-600" />;
  if (channel === 'webhook') return <Webhook className="w-5 h-5 text-blue-600" />;
  if (channel === 'email') return <Mail className="w-5 h-5 text-green-600" />;
  return <BellIcon className="w-5 h-5 text-gray-600" />;
}

/** Create / edit modal. On edit, leaving `target` blank preserves the secret. */
function DestinationModal(props: {
  existing: AlertDestination | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { existing, onClose, onSaved } = props;
  const toast = useToast();
  const [channel, setChannel] = useState<AlertDestination['channel']>(existing?.channel ?? 'slack');
  const [label, setLabel] = useState(existing?.label ?? '');
  const [target, setTarget] = useState('');
  const [minSeverity, setMinSeverity] = useState<'warning' | 'critical'>(existing?.minSeverity ?? 'warning');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!label.trim()) { toast.error('Label is required'); return; }
    if (channel !== 'in-app' && !existing && !target.trim()) {
      toast.error(channel === 'email' ? 'Email address is required' : 'Target URL is required for new Slack / webhook destinations');
      return;
    }
    setSaving(true);
    try {
      const body: AlertDestinationWrite = {
        channel,
        label: label.trim(),
        minSeverity,
        enabled,
        // Empty string on edit means "keep existing secret"; server skips
        // the update of `target` in that case.
        target: target.trim(),
      };
      if (existing) {
        await api.updateAlertDestination(existing.id, body);
        toast.success('Destination updated');
      } else {
        await api.createAlertDestination(body);
        toast.success('Destination created');
      }
      await onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={existing ? 'Edit destination' : 'Add destination'} onClose={onClose} maxWidth="max-w-md">
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Channel</label>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as AlertDestination['channel'])}
            disabled={!!existing} // channel is immutable on edit (changes target validation)
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 disabled:opacity-60"
          >
            <option value="slack">Slack incoming webhook</option>
            <option value="webhook">Generic HTTPS webhook</option>
            <option value="email">Email recipient</option>
            <option value="in-app">In-app message (deferred — logs only for now)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. SRE Slack channel"
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
          />
        </div>
        {channel !== 'in-app' && (
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              {channel === 'slack' ? 'Slack incoming-webhook URL' : channel === 'email' ? 'Email address' : 'Webhook URL'}
            </label>
            <input
              // Email targets aren't secrets — show them; URLs are bearer-equivalent, so mask.
              type={channel === 'email' ? 'text' : 'password'}
              autoComplete="off"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={existing ? '(leave blank to keep existing)' : (channel === 'slack' ? 'https://hooks.slack.com/services/...' : channel === 'email' ? 'ops@example.com' : 'https://...')}
              className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
            />
            {existing && (
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Current: <span className="font-mono">{existing.hasTarget ? existing.target : '(not set)'}</span>
              </div>
            )}
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Minimum severity</label>
          <select
            value={minSeverity}
            onChange={(e) => setMinSeverity(e.target.value as typeof minSeverity)}
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
          >
            <option value="warning">Warning + Critical</option>
            <option value="critical">Critical only</option>
          </select>
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
            disabled={saving || !label.trim()}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded disabled:opacity-50"
          >
            {saving ? 'Saving…' : (existing ? 'Save' : 'Create')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
