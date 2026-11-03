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

/** `''` → `null` (no limit); otherwise the whole number typed, or `undefined` when it isn't one. */
function parseLimit(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * The account's 80% / 100% quota notices: on/off, and an optional HTTPS
 * endpoint that receives a `quota.threshold` event alongside the inbox notice.
 * Also the account's two OPTIONAL AI controls, which ride the same settings
 * row: a per-member share of the AI calls (so one heavy user can't drain the
 * pool for everyone) and a per-period AI token budget. Both default off.
 * Shown to billing contacts of the ROOT org only — these are per account.
 */
export function QuotaNoticeSettingsCard({ orgId }: { orgId: string }) {
  const toast = useToast();
  const settingsQ = useFetch(async (signal) => (await api.getQuotaNoticeSettings(orgId, { signal })).data?.settings ?? null, [orgId]);
  const settings = settingsQ.data;
  const [webhookUrl, setWebhookUrl] = useState('');
  const [memberPct, setMemberPct] = useState('');
  const [tokenBudget, setTokenBudget] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setWebhookUrl(settings?.webhookUrl ?? ''); }, [settings?.webhookUrl]);
  useEffect(() => { setMemberPct(settings?.aiCallsPerMemberPct != null ? String(settings.aiCallsPerMemberPct) : ''); }, [settings?.aiCallsPerMemberPct]);
  useEffect(() => { setTokenBudget(settings?.aiTokenBudget != null ? String(settings.aiTokenBudget) : ''); }, [settings?.aiTokenBudget]);

  // The server's bounds (1–100 %, ≥ 1 token), checked here so a typo is named
  // beside the field rather than coming back as a 400.
  const pct = parseLimit(memberPct);
  const budget = parseLimit(tokenBudget);
  const pctInvalid = pct === undefined || (pct !== null && (pct < 1 || pct > 100));
  const budgetInvalid = budget === undefined || (budget !== null && budget < 1);
  const aiDirty = pct !== (settings?.aiCallsPerMemberPct ?? null) || budget !== (settings?.aiTokenBudget ?? null);

  async function save(data: { enabled?: boolean; webhookUrl?: string | null; aiCallsPerMemberPct?: number | null; aiTokenBudget?: number | null }) {
    setSaving(true);
    try {
      await api.updateQuotaNoticeSettings(orgId, data);
      await settingsQ.refetch();
      toast.success('Quota settings saved');
    } catch (err) {
      toast.error(formatError(err, 'Could not save quota settings'));
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
      <div className="mt-6 border-t border-default pt-4">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">AI controls (optional)</h4>
        <p className="text-xs text-fg-muted mb-3">
          Limits inside your AI calls. Leave a field empty for no limit. Calls on your organization&apos;s or a
          member&apos;s own provider key are never counted.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="ai-member-share" className="text-xs font-medium text-fg">Per-member share (%)</label>
            <p className="text-xs text-fg-muted mb-1">The most one person may use of this period&apos;s AI calls.</p>
            <Input
              id="ai-member-share"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              placeholder="No limit"
              value={memberPct}
              onChange={(e) => setMemberPct(e.target.value)}
              aria-invalid={pctInvalid || undefined}
            />
            {pctInvalid && <p className="text-xs text-danger mt-1">Enter a whole number from 1 to 100, or leave it empty.</p>}
          </div>
          <div>
            <label htmlFor="ai-token-budget" className="text-xs font-medium text-fg">Token budget per period</label>
            <p className="text-xs text-fg-muted mb-1">Total AI tokens (in + out) on the platform&apos;s key.</p>
            <Input
              id="ai-token-budget"
              type="number"
              inputMode="numeric"
              min={1}
              placeholder="No budget"
              value={tokenBudget}
              onChange={(e) => setTokenBudget(e.target.value)}
              aria-invalid={budgetInvalid || undefined}
            />
            {budgetInvalid && <p className="text-xs text-danger mt-1">Enter a whole number of tokens, or leave it empty.</p>}
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            disabled={saving || !aiDirty || pctInvalid || budgetInvalid}
            onClick={() => void save({ aiCallsPerMemberPct: pct ?? null, aiTokenBudget: budget ?? null })}
          >
            Save AI controls
          </Button>
        </div>
      </div>
    </Card>
  );
}
