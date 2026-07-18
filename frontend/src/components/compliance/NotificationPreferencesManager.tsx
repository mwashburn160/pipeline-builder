'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Save } from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Badge } from '@/components/ui/Badge';
import type { OrganizationMember } from '@/types';
import type {
  ComplianceNotificationPreference,
  ComplianceNotificationPreferenceWrite,
} from '@/types/compliance-notifications';

interface NotificationPreferencesManagerProps {
  readOnly?: boolean;
}

const labelClass = 'block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1';
const inputClass = 'w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 disabled:opacity-60';

export default function NotificationPreferencesManager({ readOnly = false }: NotificationPreferencesManagerProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasSecret, setHasSecret] = useState(false);

  const [notifyOnBlock, setNotifyOnBlock] = useState(true);
  const [notifyOnWarning, setNotifyOnWarning] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [digestMode, setDigestMode] = useState<'immediate' | 'daily' | 'weekly'>('immediate');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');

  // Email recipient picker: org members + the selected subset (empty = all admins).
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());

  const apply = useCallback((p: ComplianceNotificationPreference) => {
    setNotifyOnBlock(p.notifyOnBlock);
    setNotifyOnWarning(p.notifyOnWarning);
    setEmailEnabled(p.emailEnabled);
    setDigestMode(p.digestMode);
    setSelectedUserIds(new Set(p.targetUsers ?? []));
    setWebhookUrl(p.webhookUrl ?? '');
    setHasSecret(p.hasWebhookSecret);
    setWebhookSecret('');
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const orgId = api.getOrganizationId();
      const [prefRes, memberRes] = await Promise.all([
        api.getComplianceNotificationPreference(),
        // Recipient picker needs the whole active roster — the roster is now
        // server-paginated, so request the max page (200, the backend cap)
        // rather than the default 25.
        orgId ? api.getOrganizationMembers(orgId, { limit: 200 }) : Promise.resolve(null),
      ]);
      if (memberRes?.data?.members) setMembers(memberRes.data.members.filter((m) => m.isActive));
      if (prefRes.data?.preference) apply(prefRes.data.preference);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load notification preferences');
    }
    setLoading(false);
  }, [apply, toast]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const toggleUser = (id: string) => {
    if (readOnly) return;
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    setSaving(true);
    try {
      // Prune selections against the roster ONLY when it actually loaded — a
      // failed/empty members fetch must not wipe the saved recipients. The
      // backend re-intersects targetUsers with org membership at send time, so
      // sending an unpruned list is safe. Empty = all org admins (null).
      const selected = [...selectedUserIds];
      const memberIds = new Set(members.map((m) => m.id));
      const targetUsers = members.length > 0 ? selected.filter((id) => memberIds.has(id)) : selected;
      const body: ComplianceNotificationPreferenceWrite = {
        notifyOnBlock,
        notifyOnWarning,
        emailEnabled,
        digestMode,
        targetUsers: targetUsers.length > 0 ? targetUsers : null,
        webhookUrl: webhookUrl.trim() || null,
      };
      if (webhookSecret.trim()) body.webhookSecret = webhookSecret.trim();

      const res = await api.updateComplianceNotificationPreference(body);
      if (res.data?.preference) apply(res.data.preference);
      toast.success('Notification preferences saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save notification preferences');
    }
    setSaving(false);
  };

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-blue-600" /></div>;
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-5 max-w-2xl">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Compliance notifications</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          How this org is notified when a compliance check blocks an operation or raises warnings.
          Notifications always appear in the in-app inbox; email and webhook are opt-in below.
        </p>
      </div>

      {/* Severity gating */}
      <fieldset className="space-y-2" disabled={readOnly}>
        <legend className="sr-only">Severity</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={notifyOnBlock} onChange={(e) => setNotifyOnBlock(e.target.checked)} disabled={readOnly} />
          Notify on <strong>blocks</strong> (violations that stop an operation)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={notifyOnWarning} onChange={(e) => setNotifyOnWarning(e.target.checked)} disabled={readOnly} />
          Notify on <strong>warnings</strong> (non-blocking issues)
        </label>
      </fieldset>

      {/* Email */}
      <div className="space-y-2 border-t border-gray-200 dark:border-gray-700 pt-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={emailEnabled} onChange={(e) => setEmailEnabled(e.target.checked)} disabled={readOnly} />
          <strong>Email</strong> notifications
        </label>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className={labelClass + ' mb-0'}>Recipients</label>
            <span className="text-xs text-gray-400">{selectedUserIds.size === 0 ? 'All org admins' : `${selectedUserIds.size} selected`}</span>
          </div>
          {members.length === 0 ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">No members to choose from.</p>
          ) : (
            <div className={`max-h-48 overflow-y-auto border border-gray-300 dark:border-gray-600 rounded divide-y divide-gray-100 dark:divide-gray-800 ${(!emailEnabled || readOnly) ? 'opacity-60 pointer-events-none' : ''}`}>
              {members.map((m) => (
                <label key={m.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <input
                    type="checkbox"
                    checked={selectedUserIds.has(m.id)}
                    onChange={() => toggleUser(m.id)}
                    disabled={readOnly || !emailEnabled}
                  />
                  <span className="font-medium text-gray-900 dark:text-gray-100">{m.username}</span>
                  <span className="text-gray-500 dark:text-gray-400">{m.email}</span>
                  {(m.role === 'admin' || m.role === 'owner') && <Badge color="blue">{m.role}</Badge>}
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Select specific recipients, or leave all unchecked to email every org admin.
          </p>
        </div>
      </div>

      {/* Webhook */}
      <div className="space-y-2 border-t border-gray-200 dark:border-gray-700 pt-4">
        <div>
          <label className={labelClass}>Webhook URL</label>
          <input
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            disabled={readOnly}
            placeholder="https://… (leave blank to disable)"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Webhook signing secret</label>
          <input
            type="password"
            autoComplete="off"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            disabled={readOnly}
            placeholder={hasSecret ? '(leave blank to keep existing)' : 'optional — signs the X-PB-Signature header'}
            className={`${inputClass} font-mono`}
          />
        </div>
      </div>

      {/* Digest cadence */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
        <label className={labelClass}>Delivery cadence</label>
        <select
          value={digestMode}
          onChange={(e) => setDigestMode(e.target.value as typeof digestMode)}
          disabled={readOnly}
          className={inputClass}
        >
          <option value="immediate">Immediate</option>
          <option value="daily">Daily digest</option>
          <option value="weekly">Weekly digest</option>
        </select>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Digests batch notifications and deliver them once per day/week instead of immediately.
        </p>
      </div>

      {!readOnly && (
        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm bg-blue-600 text-white rounded disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving…' : 'Save preferences'}
          </button>
        </div>
      )}
    </form>
  );
}
