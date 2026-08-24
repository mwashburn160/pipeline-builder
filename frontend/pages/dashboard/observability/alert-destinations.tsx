// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
// lucide-react v1 removed brand icons (e.g. Slack); use a generic messaging glyph.
import { Bell, Plus, Trash2, Edit2, MessageSquare, Webhook, Mail, Bell as BellIcon, Send } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Modal } from '@/components/ui/Modal';
import { Checkbox } from '@/components/ui/Checkbox';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { FilterInput } from '@/components/ui/FilterInput';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { CopyableId } from '@/components/ui/CopyableId';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { api, getErrorMessage } from '@/lib/api';
import type { AlertDestination, AlertDestinationWrite } from '@/types/observability';

/** Badge color per delivery channel. */
function channelColor(channel: AlertDestination['channel']): 'purple' | 'blue' | 'green' | 'gray' {
  return channel === 'slack' ? 'purple' : channel === 'webhook' ? 'blue' : channel === 'email' ? 'green' : 'gray';
}

/**
 * Per-org alert destinations settings page.
 *
 * Multi-tenant alerting routes Alertmanager webhooks to the platform's
 * alert-relay, which looks up destinations here for the firing alert's
 * `org_id` label and fans out to each one. Operators register their Slack
 * incoming-webhook URLs (or generic HTTPS webhooks, or opt into in-app)
 * here; the platform never logs or returns the raw target back — only a
 * masked `••••XXXX` preview.
 *
 * Viewing destinations requires `observability:read` (Members hold it per the
 * catalog). Managing destinations (add / edit / delete / send-test) is an
 * `observability:write` capability — the backend gates every POST/PUT/DELETE
 * and the test endpoint on it, and here each write control is gated on
 * `can('observability:write')` (which also reports false under read-only
 * impersonation). Superadmins bypass the permission check, so the read-only
 * cross-tenant view below stays reachable.
 */
export default function AlertDestinationsPage() {
  const { isReady, isAuthenticated, isSuperAdmin, can } = useAuthGuard({ requirePermission: 'observability:read' });
  const canWrite = can('observability:write');
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

  // Delete confirmation (in-app modal, replacing the native confirm()).
  const [pendingDelete, setPendingDelete] = useState<AlertDestination | null>(null);
  const [deleting, setDeleting] = useState(false);
  const onDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteAlertDestination(pendingDelete.id);
      toast.success('Destination deleted');
      await refresh();
      setPendingDelete(null);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  // Per-destination "send test" — id of the row currently sending (for the
  // spinner/disabled state); a delivery failure toasts the downstream reason.
  const [testingId, setTestingId] = useState<string | null>(null);
  const onTest = async (d: AlertDestination) => {
    setTestingId(d.id);
    try {
      await api.testAlertDestination(d.id);
      toast.success('Test sent');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setTestingId(null);
    }
  };

  // Cross-tenant view: one flat table (sorted by org, then label) with search +
  // channel filters — replaces the former per-org card groups.
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return destinations
      .filter((d) => {
        if (channelFilter !== 'all' && d.channel !== channelFilter) return false;
        if (!term) return true;
        return (d.orgId ?? '').toLowerCase().includes(term) || d.label.toLowerCase().includes(term);
      })
      .sort((a, b) => (a.orgId ?? '').localeCompare(b.orgId ?? '') || a.label.localeCompare(b.label));
  }, [destinations, search, channelFilter]);

  // ── Columns ──
  const crossOrgColumns: Column<AlertDestination>[] = [
    {
      id: 'org', header: 'Organization',
      render: (d) => (
        <div className="flex items-center gap-2">
          <CopyableId value={d.orgId ?? '(unknown)'} size="sm" />
          {d.orgId && <Link href={`/dashboard/admin/orgs/${d.orgId}`} className="action-link text-xs">detail</Link>}
        </div>
      ),
    },
    { id: 'channel', header: 'Channel', render: (d) => <Badge color={channelColor(d.channel)}>{d.channel}</Badge> },
    { id: 'label', header: 'Label', cellClassName: 'font-medium text-gray-900 dark:text-gray-100', render: (d) => d.label },
    { id: 'severity', header: 'Min severity', render: (d) => <Badge color={d.minSeverity === 'critical' ? 'red' : 'yellow'}>{d.minSeverity}</Badge> },
    { id: 'enabled', header: 'Enabled', render: (d) => (d.enabled ? <Badge color="green">enabled</Badge> : <Badge color="gray">disabled</Badge>) },
    { id: 'target', header: 'Target', cellClassName: 'font-mono text-xs text-gray-500 dark:text-gray-400', render: (d) => (d.hasTarget ? d.target : '—') },
  ];

  const orgColumns: Column<AlertDestination>[] = [
    {
      id: 'channel', header: 'Channel',
      render: (d) => (
        <span className="inline-flex items-center gap-2">
          <ChannelIcon channel={d.channel} />
          <Badge color={channelColor(d.channel)}>{d.channel}</Badge>
        </span>
      ),
    },
    { id: 'label', header: 'Label', cellClassName: 'font-medium text-gray-900 dark:text-gray-100', render: (d) => d.label },
    { id: 'severity', header: 'Min severity', render: (d) => <Badge color={d.minSeverity === 'critical' ? 'red' : 'yellow'}>≥ {d.minSeverity}</Badge> },
    { id: 'enabled', header: 'Enabled', render: (d) => (d.enabled ? <Badge color="green">enabled</Badge> : <Badge color="gray">disabled</Badge>) },
    {
      id: 'target', header: 'Target', cellClassName: 'font-mono text-xs text-gray-500 dark:text-gray-400',
      render: (d) => (d.channel === 'in-app' ? '(in-app messages)' : d.hasTarget ? d.target : '— no target set —'),
    },
    ...(canWrite
      ? [{
        id: 'actions', header: '', cellClassName: 'text-right',
        render: (d: AlertDestination) => (
          <div className="inline-flex items-center justify-end gap-1">
            <Button
              variant="ghost" size="xs" onClick={() => void onTest(d)} disabled={testingId === d.id}
              aria-label="Send test notification" title="Send a test notification to this destination" className="gap-1"
            >
              <Send className="w-3.5 h-3.5" /> {testingId === d.id ? 'Sending…' : 'Send test'}
            </Button>
            <IconButton onClick={() => setEditing(d)} aria-label="Edit destination"><Edit2 className="w-4 h-4" /></IconButton>
            <IconButton onClick={() => setPendingDelete(d)} tone="danger" aria-label="Delete destination"><Trash2 className="w-4 h-4" /></IconButton>
          </div>
        ),
      } as Column<AlertDestination>]
      : []),
  ];

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
              <Checkbox checked={allOrgs} onChange={(e) => setAllOrgs(e.target.checked)} />
              All organizations
            </label>
          )}
          {!viewingAll && canWrite && (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setCreating(true)}
              className="gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add destination
            </Button>
          )}
        </div>
      }
    >
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        See current firing alerts on the <Link href="/dashboard/observability/alerts" className="text-blue-600 hover:underline">Alerts page</Link>.
      </div>

      <ErrorAlert message={error?.message} className="mb-4" />

      {viewingAll ? (
        /* ───── Sysadmin cross-tenant view (read-only, grouped by org) ───── */
        <>
          <div className="filter-bar flex flex-wrap items-center gap-2 mb-4">
            <FilterInput
              type="text"
              placeholder="Filter by org id or label..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 min-w-[16rem]"
            />
            <FilterSelect
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value as typeof channelFilter)}
              aria-label="Filter by channel"
            >
              <option value="all">All channels</option>
              <option value="slack">Slack</option>
              <option value="webhook">Webhook</option>
              <option value="in-app">In-app</option>
              <option value="email">Email</option>
            </FilterSelect>
          </div>
          <div className="overflow-x-auto">
            <DataTable
              data={filtered}
              columns={crossOrgColumns}
              isLoading={loading}
              animated={false}
              getRowKey={(d) => d.id}
              emptyState={{ icon: Bell, title: 'No destinations', description: 'No destinations match the current filters.' }}
            />
          </div>
          <div className="mt-6 text-xs text-gray-500 dark:text-gray-400">
            Read-only across orgs — targets are masked even for sysadmins. Turn off
            “All organizations” to manage your own org&apos;s destinations.
          </div>
        </>
      ) : (
        /* ───── Org-scoped editable view ───── */
        <div className="overflow-x-auto">
          <DataTable
            data={destinations}
            columns={orgColumns}
            isLoading={loading}
            animated={false}
            getRowKey={(d) => d.id}
            emptyState={{ icon: Bell, title: 'No destinations configured yet', description: 'Click “Add destination” above to start receiving alerts in Slack.' }}
          />
        </div>
      )}

      {(creating || editing) && (
        <DestinationModal
          existing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={async () => { await refresh(); setCreating(false); setEditing(null); }}
        />
      )}

      {pendingDelete && (
        <DeleteConfirmModal
          title="Delete destination"
          itemName={pendingDelete.label}
          loading={deleting}
          onConfirm={() => void onDelete()}
          onCancel={() => setPendingDelete(null)}
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
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={existing ? 'Edit destination' : 'Add destination'} onClose={onClose} maxWidth="max-w-md">
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Channel</label>
          <Select
            value={channel}
            onChange={(e) => setChannel(e.target.value as AlertDestination['channel'])}
            disabled={!!existing} // channel is immutable on edit (changes target validation)
            className="disabled:opacity-60"
          >
            <option value="slack">Slack incoming webhook</option>
            <option value="webhook">Generic HTTPS webhook</option>
            <option value="email">Email recipient</option>
            {/* In-app delivery has no real delivery path yet (the relay only logs
                it), so don't offer a silently-nonfunctional channel. Kept in the
                list — disabled — so an existing in-app destination still labels
                correctly on edit (channel is immutable there anyway). */}
            <option value="in-app" disabled>In-app message (coming soon — not yet delivered)</option>
          </Select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Label</label>
          <Input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. SRE Slack channel"
          />
        </div>
        {channel !== 'in-app' && (
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              {channel === 'slack' ? 'Slack incoming-webhook URL' : channel === 'email' ? 'Email address' : 'Webhook URL'}
            </label>
            <Input
              // Email targets aren't secrets — show them; URLs are bearer-equivalent, so mask.
              type={channel === 'email' ? 'text' : 'password'}
              autoComplete="off"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={existing ? '(leave blank to keep existing)' : (channel === 'slack' ? 'https://hooks.slack.com/services/...' : channel === 'email' ? 'ops@example.com' : 'https://...')}
              className="font-mono"
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
          <Select
            value={minSeverity}
            onChange={(e) => setMinSeverity(e.target.value as typeof minSeverity)}
          >
            <option value="warning">Warning + Critical</option>
            <option value="critical">Critical only</option>
          </Select>
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
            disabled={saving || !label.trim()}
          >
            {saving ? 'Saving…' : (existing ? 'Save' : 'Create')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
