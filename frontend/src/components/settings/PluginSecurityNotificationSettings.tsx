// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useId, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { Select } from '@/components/ui/Select';
import { ToggleRow } from '@/components/ui/SettingRow';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { queries } from '@/lib/api-cache';
import { formatError } from '@/lib/constants';
import { runQuery } from '@/lib/query-cache';
import type { OrganizationMember } from '@/types';
import type {
  PluginSecurityDigestMode, PluginSecurityNotificationPrefs, PluginSecurityNotificationPrefsWrite, PluginSecurityRecipientMode,
  PluginSecurityTestResult,
} from '@/types/plugin-security-notifications';

const NO_MEMBERS: OrganizationMember[] = [];

/** The editable part of the settings; secrets and the address are write-only and live apart. */
interface Draft {
  recipientMode: PluginSecurityRecipientMode;
  targetUsers: string[];
  notifyRescan: boolean;
  digestMode: PluginSecurityDigestMode;
  webhookUrl: string;
}

function draftOf(p: PluginSecurityNotificationPrefs): Draft {
  return {
    recipientMode: p.recipientMode,
    targetUsers: [...p.targetUsers],
    notifyRescan: p.notifyRescan,
    digestMode: p.digestMode,
    webhookUrl: p.webhookUrl ?? '',
  };
}

/** Client-side check that mirrors the server's: webhooks are https only. */
export function webhookUrlProblem(url: string): string | null {
  const v = url.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? null : 'The webhook URL must start with https://';
  } catch {
    return 'Enter a full URL, e.g. https://hooks.example.com/pipeline-builder';
  }
}

/** What a test send could not do, in words (empty = every configured channel delivered). */
export function testProblems(result: PluginSecurityTestResult | undefined): string[] {
  if (!result) return [];
  const out: string[] = [];
  if (result.relay === 'failed') out.push('the in-app and email notice failed');
  if (result.webhook && !result.webhook.ok) {
    out.push(`the webhook failed${result.webhook.code ? ` (HTTP ${result.webhook.code})` : result.webhook.error ? ` (${result.webhook.error})` : ''}`);
  }
  if (result.externalEmail === 'pending') out.push('the external address is not confirmed yet, so it was skipped');
  return out;
}

/** Loose address check; the server validates and sends the confirmation. */
const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/**
 * Settings → Organization → "Plugin security notifications".
 *
 * Who hears when the scan gates block a plugin version (unscanned, or fixable
 * Critical findings over the platform floor — always sent at once) and when a
 * nightly rescan finds new Critical / High findings in a stored version (can
 * be turned off or batched into a digest). Recipients are the uploader and
 * everyone who can write plugins, or a chosen list of members; plus an
 * optional signed webhook and one external address, which receives nothing
 * until its owner clicks the confirmation link.
 *
 * Visible with `plugins:read` (read-only); `canEdit` (`org:settings`) adds the
 * write controls, which `readOnly` (a read-only session) disables.
 */
export function PluginSecurityNotificationSettings({ orgId, canEdit, readOnly }: {
  orgId: string;
  canEdit: boolean;
  readOnly: boolean;
}) {
  const uid = useId();
  const toast = useToast();
  const [prefs, setPrefs] = useState<PluginSecurityNotificationPrefs | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((p: PluginSecurityNotificationPrefs) => {
    setPrefs(p);
    setDraft(draftOf(p));
    setSecret('');
    setClearSecret(false);
    setNewEmail('');
  }, []);

  const read = useFetch(async (signal) => {
    const [prefRes, memberRes] = await Promise.all([
      api.getPluginSecurityNotifications({ signal }),
      // The recipient picker needs the whole active roster (200 = the backend
      // page cap). A roster failure leaves the picker empty but the card usable.
      runQuery(queries.orgMembers(orgId, { limit: 200 }), { signal }).catch(() => null),
    ]);
    return {
      preferences: prefRes.data?.preferences ?? null,
      members: memberRes?.data?.members?.filter((m) => m.isActive) ?? NO_MEMBERS,
    };
  }, [orgId], {
    onSuccess: (v) => { if (v.preferences) apply(v.preferences); },
  });
  const members = read.data?.members ?? NO_MEMBERS;
  const editable = canEdit && !readOnly;

  const urlProblem = draft ? webhookUrlProblem(draft.webhookUrl) : null;
  const emailProblem = newEmail.trim() && !looksLikeEmail(newEmail) ? 'Enter an email address' : null;
  const usersMissing = draft?.recipientMode === 'users' && draft.targetUsers.length === 0;

  const dirty = !!prefs && !!draft && (
    draft.recipientMode !== prefs.recipientMode
    || draft.notifyRescan !== prefs.notifyRescan
    || draft.digestMode !== prefs.digestMode
    || draft.webhookUrl.trim() !== (prefs.webhookUrl ?? '')
    || [...draft.targetUsers].sort().join(',') !== [...prefs.targetUsers].sort().join(',')
    || secret.trim() !== '' || clearSecret || newEmail.trim() !== ''
  );

  const save = async () => {
    if (!draft || !prefs || urlProblem || emailProblem || usersMissing) return;
    setSaving(true);
    setError(null);
    try {
      const body: PluginSecurityNotificationPrefsWrite = {
        recipientMode: draft.recipientMode,
        targetUsers: draft.recipientMode === 'users' ? draft.targetUsers : [],
        notifyRescan: draft.notifyRescan,
        digestMode: draft.digestMode,
        webhookUrl: draft.webhookUrl.trim() || null,
      };
      if (secret.trim()) body.webhookSecret = secret.trim();
      else if (clearSecret) body.webhookSecret = null;
      if (newEmail.trim()) body.externalEmail = newEmail.trim();
      const res = await api.updatePluginSecurityNotifications(body);
      if (res.data?.preferences) apply(res.data.preferences);
      toast.success(newEmail.trim()
        ? 'Saved. We sent a confirmation link to the new address; it gets nothing until it is confirmed.'
        : 'Plugin security notifications saved');
    } catch (err) {
      setError(formatError(err, 'Could not save the notification settings'));
    } finally {
      setSaving(false);
    }
  };

  const removeEmail = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.updatePluginSecurityNotifications({ externalEmail: null });
      if (res.data?.preferences) apply(res.data.preferences);
      toast.success('External address removed');
    } catch (err) {
      setError(formatError(err, 'Could not remove the address'));
    } finally {
      setSaving(false);
    }
  };

  const resend = async () => {
    setResending(true);
    setError(null);
    try {
      const res = await api.updatePluginSecurityNotifications({ resendConfirmation: true });
      if (res.data?.preferences) apply(res.data.preferences);
      toast.success('Confirmation link sent again');
    } catch (err) {
      setError(formatError(err, 'Could not resend the confirmation'));
    } finally {
      setResending(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setError(null);
    try {
      const res = await api.sendPluginSecurityNotificationTest();
      const problems = testProblems(res.data?.result);
      if (problems.length > 0) toast.warning(`Test sent, but ${problems.join('; ')}`);
      else toast.success('Test notice sent to every configured channel');
    } catch (err) {
      setError(formatError(err, 'Could not send the test notice'));
    } finally {
      setTesting(false);
    }
  };

  const toggleUser = (id: string) => {
    if (!draft) return;
    const has = draft.targetUsers.includes(id);
    setDraft({ ...draft, targetUsers: has ? draft.targetUsers.filter((u) => u !== id) : [...draft.targetUsers, id] });
  };

  const memberName = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m ? (m.username || m.email) : id;
  };

  return (
    <SectionCard
      icon={ShieldAlert}
      title="Plugin security notifications"
      description="Who hears when a plugin version is blocked for vulnerabilities, or a rescan finds new Critical or High findings in one."
      actions={canEdit ? (
        <Button variant="secondary" size="sm" onClick={sendTest} loading={testing} readOnly={readOnly} disabled={!prefs || dirty}
          title={dirty ? 'Save your changes first' : undefined}>
          Send test
        </Button>
      ) : undefined}
    >
      {error && <div className="mb-3"><Callout variant="danger">{error}</Callout></div>}

      {read.error && !prefs ? (
        <RetryError message={formatError(read.error, 'Could not load the notification settings')} onRetry={read.refetch} />
      ) : !prefs || !draft ? (
        <div className="flex items-center gap-2 py-4 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading…</div>
      ) : (
        <div className="space-y-5" data-testid="plugin-security-notifications">
          <p className="text-xs text-fg-muted">
            A version blocked at build (it could not be scanned, or it has fixable Critical findings) is always reported at once.
          </p>

          <fieldset disabled={!editable} className="space-y-2">
            <legend className="text-sm font-medium text-fg">Recipients</legend>
            {([
              ['writers', 'The uploader and everyone who can write plugins'],
              ['users', 'Only the members I choose'],
            ] as const).map(([value, label]) => (
              <label key={value} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${uid}-recipients`}
                  value={value}
                  checked={draft.recipientMode === value}
                  onChange={() => setDraft({ ...draft, recipientMode: value })}
                />
                {label}
              </label>
            ))}
            {draft.recipientMode === 'users' && (
              editable ? (
                members.length === 0 ? (
                  <p className="text-xs text-fg-muted">No members to choose from.</p>
                ) : (
                  <div className="max-h-48 overflow-y-auto rounded border border-default divide-y divide-default" role="group" aria-label="Members to notify">
                    {members.map((m) => (
                      <label key={m.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-muted">
                        <Checkbox checked={draft.targetUsers.includes(m.id)} onChange={() => toggleUser(m.id)} />
                        <span className="font-medium text-fg">{m.username}</span>
                        <span className="text-fg-muted">{m.email}</span>
                      </label>
                    ))}
                  </div>
                )
              ) : (
                <p className="text-sm text-fg" data-testid="target-users">
                  {draft.targetUsers.length > 0 ? draft.targetUsers.map(memberName).join(', ') : 'No one chosen'}
                </p>
              )
            )}
            {usersMissing && editable && <p className="text-xs text-danger">Choose at least one member.</p>}
          </fieldset>

          <div className="divide-y divide-default border-y border-default">
            <ToggleRow
              label="Rescan findings"
              description="Tell recipients when the nightly rescan finds new Critical or High findings in a plugin version already stored."
              checked={draft.notifyRescan}
              disabled={!editable}
              onChange={(v) => setDraft({ ...draft, notifyRescan: v })}
            />
          </div>

          <FormField label="Rescan delivery" hint="Blocked versions are always sent immediately.">
            <Select
              value={draft.digestMode}
              onChange={(e) => setDraft({ ...draft, digestMode: e.target.value as PluginSecurityDigestMode })}
              disabled={!editable || !draft.notifyRescan}
            >
              <option value="immediate">Immediately</option>
              <option value="daily">Daily digest</option>
              <option value="weekly">Weekly digest</option>
            </Select>
          </FormField>

          <div className="space-y-3 border-t border-default pt-4">
            <FormField label="Webhook URL" error={editable ? urlProblem ?? undefined : undefined} hint="Optional. https only; each delivery is signed with X-PB-Signature when a secret is set.">
              <Input
                type="url"
                value={draft.webhookUrl}
                onChange={(e) => setDraft({ ...draft, webhookUrl: e.target.value })}
                placeholder="https://… (leave blank for none)"
                disabled={!editable}
              />
            </FormField>
            {canEdit ? (
              <FormField
                label="Webhook signing secret"
                hint={prefs.hasWebhookSecret ? 'A secret is set. It is never shown again; type a new one to replace it.' : 'Optional. Used to sign each delivery (HMAC-SHA256).'}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => { setSecret(e.target.value); setClearSecret(false); }}
                  placeholder={prefs.hasWebhookSecret ? '(leave blank to keep the current secret)' : 'optional'}
                  className="font-mono"
                  disabled={!editable || clearSecret}
                />
              </FormField>
            ) : (
              <p className="text-sm text-fg-muted">Webhook signing secret: {prefs.hasWebhookSecret ? 'set' : 'not set'}</p>
            )}
            {canEdit && prefs.hasWebhookSecret && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={clearSecret} onChange={(e) => { setClearSecret(e.target.checked); setSecret(''); }} disabled={!editable} />
                Remove the signing secret
              </label>
            )}
          </div>

          <div className="space-y-2 border-t border-default pt-4">
            <p className="text-sm font-medium text-fg">External address</p>
            <p className="text-xs text-fg-muted">
              One address outside the organization, such as a security team&apos;s mailbox. It receives these two notices only,
              and only after its owner confirms it from the link we email to it.
            </p>
            {prefs.externalEmail ? (
              <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="external-email">
                <span className="font-mono">{prefs.externalEmail.masked}</span>
                {prefs.externalEmail.verified
                  ? <Badge color="green">Verified</Badge>
                  : <Badge color="yellow">{prefs.externalEmail.pendingExpiresAt ? 'Pending confirmation' : 'Confirmation link expired'}</Badge>}
                {canEdit && !prefs.externalEmail.verified && (
                  <Button variant="ghost" size="xs" onClick={resend} loading={resending} readOnly={readOnly}>
                    Resend confirmation
                  </Button>
                )}
                {canEdit && (
                  <Button variant="ghost" size="xs" onClick={removeEmail} readOnly={readOnly} disabled={saving}>
                    Remove
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-sm text-fg-muted">None</p>
            )}
            {canEdit && (
              <FormField label={prefs.externalEmail ? 'Replace with' : 'Add an address'} error={emailProblem ?? undefined}>
                <Input
                  type="email"
                  autoComplete="off"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="security@example.com"
                  disabled={!editable}
                />
              </FormField>
            )}
          </div>

          {canEdit && (
            <div className="flex justify-end">
              <Button
                onClick={save}
                loading={saving}
                readOnly={readOnly}
                disabled={!dirty || !!urlProblem || !!emailProblem || usersMissing}
              >
                Save notification settings
              </Button>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
