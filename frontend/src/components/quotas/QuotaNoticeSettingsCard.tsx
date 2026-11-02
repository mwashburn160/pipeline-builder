// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';

/**
 * The account's 80% / 100% quota notices: on/off, and an optional HTTPS
 * endpoint that receives a `quota.threshold` event alongside the inbox notice.
 * Shown to billing contacts of the ROOT org only — notices are per account.
 */
export function QuotaNoticeSettingsCard({ orgId }: { orgId: string }) {
  const toast = useToast();
  const settingsQ = useFetch(async (signal) => (await api.getQuotaNoticeSettings(orgId, { signal })).data?.settings ?? null, [orgId]);
  const settings = settingsQ.data;
  const [webhookUrl, setWebhookUrl] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setWebhookUrl(settings?.webhookUrl ?? ''); }, [settings?.webhookUrl]);

  async function save(data: { enabled?: boolean; webhookUrl?: string | null }) {
    setSaving(true);
    try {
      await api.updateQuotaNoticeSettings(orgId, data);
      await settingsQ.refetch();
      toast.success('Notice settings saved');
    } catch (err) {
      toast.error(formatError(err, 'Could not save notice settings'));
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;
  return (
    <Card className="mt-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-fg">Quota notices</h3>
          <p className="text-xs text-fg-muted mt-0.5">
            A notice in your organization&apos;s inbox when any quota reaches 80% and 100% of this period&apos;s limit — once per quota per period.
            {settings.noticesEnabledOnInstance === false ? ' Notices are currently switched off for this installation.' : ''}
          </p>
        </div>
        <Switch
          checked={settings.enabled}
          onChange={(enabled) => void save({ enabled })}
          disabled={saving}
          aria-label="Send quota notices"
        />
      </div>
      <div className="mt-4">
        <label htmlFor="quota-webhook" className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
          Webhook (optional)
        </label>
        <p className="text-xs text-fg-muted mb-2">Receives a <code>quota.threshold</code> JSON event with the quota, threshold, usage and reset time.</p>
        <div className="flex gap-2">
          <Input
            id="quota-webhook"
            type="url"
            placeholder="https://hooks.example.com/quota"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            className="flex-1"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={saving || webhookUrl === (settings.webhookUrl ?? '')}
            onClick={() => void save({ webhookUrl: webhookUrl.trim() || null })}
          >
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}
