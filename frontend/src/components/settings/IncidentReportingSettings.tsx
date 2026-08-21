// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { Siren, KeyRound, Webhook, FlaskConical, Clock, Archive } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { FormField } from '@/components/ui/FormField';
import { Badge } from '@/components/ui/Badge';
import { CopyButton } from '@/components/ui/CopyButton';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useLoadable } from '@/hooks/useLoadable';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { IncidentSettings, IncidentListItem, IncidentTestResult } from '@/lib/api/domains/reporting';

/** The machine scope the self-serve webhook token carries. */
const REPORTING_INGEST_SCOPE = 'reporting:ingest';

/**
 * Billing deep-link that highlights the DORA-History pack on the add-ons grid
 * (AddonGrid keys `?highlight=` on bundle id/name as well as features). Buying a
 * retention / DORA-History pack is the ONLY way to raise the billing-owned
 * retention horizon.
 */
const RETENTION_PACK_HIGHLIGHT = '/dashboard/billing?highlight=dora_history_pack';

/** Format a retention day count for read-only display; `-1` → "Unlimited". */
function fmtRetentionDays(days: number): string {
  return days < 0 ? 'Unlimited' : `${days} ${days === 1 ? 'day' : 'days'}`;
}

type ProviderKey = 'alertmanager' | 'pagerduty' | 'datadog' | 'generic';

/** Per-provider copy-paste setup guidance, including the required environment mapping. */
function providerGuide(key: ProviderKey, genericUrl: string, alertmanagerUrl: string): { label: string; endpoint: string; steps: string[] } {
  switch (key) {
    case 'alertmanager':
      return {
        label: 'Prometheus Alertmanager (native)',
        endpoint: alertmanagerUrl,
        steps: [
          'Add a webhook_config receiver in your Alertmanager config pointing at the adapter URL above, with the bearer token below.',
          'The adapter maps each alert → one incident: fingerprint → incidentId, startsAt → openedAt, endsAt → resolvedAt (on resolve).',
          'Set an `environment` label on the alerting rules (e.g. environment="production"). Override the label name with ?environmentLabel=<label> on the URL.',
          'Set a `severity` label (critical/warning/…); it maps to the incident severity. Alerts missing environment or a stable fingerprint are skipped.',
        ],
      };
    case 'pagerduty':
      return {
        label: 'PagerDuty (generic webhook)',
        endpoint: genericUrl,
        steps: [
          'Create a Webhook v3 subscription (or a custom payload template) targeting the generic URL above with the bearer token below.',
          'Map fields to the contract: incident.id → incidentId, incident.created_at → openedAt, incident.resolved_at → resolvedAt, urgency/priority → severity.',
          'Set `environment` from the affected service — it MUST match the environment you declared on the deploy stage (e.g. production).',
          'Fire the webhook on both incident open and resolve; the resolve POST re-uses the same incidentId (idempotent upsert).',
        ],
      };
    case 'datadog':
      return {
        label: 'Datadog (webhook notification)',
        endpoint: genericUrl,
        steps: [
          'Create a Webhooks integration notification on your monitor targeting the generic URL above with the bearer token below.',
          'Template the JSON body: $ALERT_ID → incidentId, $DATE/$LAST_UPDATED → openedAt/resolvedAt, and use $ALERT_STATUS to decide whether resolvedAt is sent.',
          'Set `environment` from a monitor tag — it MUST match your deploy-stage environment (e.g. production).',
          'Notify on both trigger and recovery so the resolve updates resolvedAt (idempotent on incidentId).',
        ],
      };
    default:
      return {
        label: 'Generic (any tool that POSTs JSON)',
        endpoint: genericUrl,
        steps: [
          'POST JSON to the generic URL above with the bearer token below (Authorization: Bearer <token>).',
          'Body: { incidentId, environment, openedAt (ISO 8601), resolvedAt? (ISO 8601), severity }.',
          '`environment` MUST match the environment declared on your deploy stage (e.g. production) so DORA can correlate.',
          'Re-POST the same incidentId with resolvedAt set when the incident resolves — it is an idempotent upsert keyed on (org, incidentId).',
        ],
      };
  }
}

/**
 * Org-admin "Incident reporting" settings panel (Phase 5b). Sets up + configures
 * the PagerDuty / Datadog / Alertmanager → DORA incident webhook: the endpoint
 * URLs (incl. the native Alertmanager adapter), the self-serve `reporting:ingest`
 * webhook token (reuses the PAT issuance — copy-once, step-up gated), provider
 * presets with copy-paste setup, the per-org correlation-window override, a
 * non-persisting "send test incident" wiring check, and the recent-incidents list.
 */
export function IncidentReportingSettings() {
  const toast = useToast();

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const genericUrl = `${origin}/api/reports/incidents`;
  const alertmanagerUrl = `${origin}/api/reports/incidents/alertmanager`;

  // ── Per-org correlation window ──
  const loadSettings = useCallback(async (): Promise<IncidentSettings | null> => {
    return (await api.getIncidentSettings()) ?? null;
  }, []);
  const { data: settings, loading: settingsLoading, reload: reloadSettings } = useLoadable<IncidentSettings | null>(
    loadSettings, null, 'Failed to load incident settings',
  );
  const [windowInput, setWindowInput] = useState('');
  const [savingWindow, setSavingWindow] = useState(false);
  const effectiveWindow = settings?.incidentWindowHours ?? settings?.defaultWindowHours ?? 24;

  const saveWindow = async () => {
    const h = Math.floor(Number(windowInput));
    if (!Number.isFinite(h) || h < 1 || h > 720) { toast.error('Window must be 1–720 hours'); return; }
    setSavingWindow(true);
    try {
      await api.putReportingSettings({ incidentWindowHours: h });
      toast.success('Correlation window updated');
      setWindowInput('');
      void reloadSettings();
    } catch (err) {
      toast.error(formatError(err, 'Failed to update window'));
    } finally {
      setSavingWindow(false);
    }
  };

  // ── Per-org retention windows (Phase 7) — READ-ONLY ──
  // Retention is billing-owned: the effective value is (override ?? default),
  // written only by the billing→reporting retention sync when a retention /
  // DORA-History pack is purchased. `-1` means unlimited. Admins raise it by
  // buying a pack (deep-link CTA below), not by editing here.
  const effectiveEventDays = settings?.eventRetentionDays ?? settings?.defaultEventRetentionDays ?? 30;
  const effectiveDoraDays = settings?.doraRetentionDays ?? settings?.defaultDoraRetentionDays ?? 180;

  // ── Self-serve webhook token (reuses PAT issuance; copy-once + step-up) ──
  const [newToken, setNewToken] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<{ name: string; expiresIn: number; scope: string } | null>(null);
  const [creating, setCreating] = useState(false);

  const requestToken = () => {
    // 1-year token, org-bound + least-privilege (the `reporting:ingest` scope
    // forces role=member, no features/permissions) — minted by the platform.
    setPendingCreate({ name: `incident-webhook-${new Date().toISOString().slice(0, 10)}`, expiresIn: 365 * 86400, scope: REPORTING_INGEST_SCOPE });
  };

  const executeCreate = async (stepUpToken: string) => {
    if (!pendingCreate) return;
    setCreating(true);
    setNewToken(null);
    try {
      const res = await api.createPat(pendingCreate, stepUpToken);
      if (res.success && res.data) {
        setNewToken(res.data.token);
        toast.success('Webhook token created');
      } else {
        toast.error('Failed to create token');
      }
    } catch (err) {
      toast.error(formatError(err, 'Failed to create token'));
    } finally {
      setCreating(false);
      setPendingCreate(null);
    }
  };

  // ── Provider presets ──
  const [provider, setProvider] = useState<ProviderKey>('alertmanager');
  const guide = useMemo(() => providerGuide(provider, genericUrl, alertmanagerUrl), [provider, genericUrl, alertmanagerUrl]);

  // ── Send test incident (non-persisting dry-run) ──
  const [testEnv, setTestEnv] = useState('production');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<IncidentTestResult | null>(null);

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.sendTestIncident(testEnv.trim() || 'production');
      if (r) {
        setTestResult(r);
        if (r.correlated) toast.success('Test incident correlated to a recent deploy');
        else toast.warning('No recent deploy correlated — check the environment name + window');
      }
    } catch (err) {
      toast.error(formatError(err, 'Test failed'));
    } finally {
      setTesting(false);
    }
  };

  // ── Recent incidents list ──
  const loadIncidents = useCallback(async (): Promise<IncidentListItem[]> => {
    const res = await api.listIncidents({ limit: 25, offset: 0 });
    if (res.success && res.data) return res.data.incidents;
    throw new Error('Failed to load incidents');
  }, []);
  const { data: incidents, loading: incidentsLoading, error: incidentsError, reload: reloadIncidents } = useLoadable<IncidentListItem[]>(
    loadIncidents, [], 'Failed to load incidents',
  );

  const incidentColumns: Column<IncidentListItem>[] = [
    { id: 'incidentId', header: 'Incident', cellClassName: 'font-mono text-xs text-gray-800 dark:text-gray-200', render: (i) => i.incidentId },
    { id: 'environment', header: 'Environment', render: (i) => i.environment },
    { id: 'severity', header: 'Severity', render: (i) => <Badge color="gray">{i.severity}</Badge> },
    {
      id: 'state', header: 'State',
      render: (i) => <Badge color={i.resolved ? 'green' : 'red'}>{i.resolved ? 'resolved' : 'open'}</Badge>,
    },
    {
      id: 'correlated', header: 'Correlated deploy',
      render: (i) => (i.correlatedExecutionId
        ? <span className="font-mono text-xs text-gray-600 dark:text-gray-300">{i.correlatedExecutionId}</span>
        : <span className="text-xs text-gray-400">none</span>),
    },
    { id: 'openedAt', header: 'Opened', render: (i) => (i.openedAt ? <RelativeTime value={i.openedAt} /> : '—') },
  ];

  return (
    <div className="space-y-6">
      {/* Overview */}
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <Siren className="w-5 h-5 text-gray-500" />
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">Incident reporting</h2>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Point your incident tooling (PagerDuty, Datadog, or in-cluster Alertmanager) at Pipeline Builder to feed
          DORA <strong>automated post-deploy Change Failure Rate</strong> + <strong>real Mean Time To Restore</strong>.
          Each incident is correlated to the most recent successful deploy to its environment.
        </p>
      </Card>

      {/* Endpoints */}
      <Card>
        <div className="flex items-center gap-2 mb-3">
          <Webhook className="w-5 h-5 text-gray-500" />
          <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">Webhook endpoints</h3>
        </div>
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Generic (PagerDuty / Datadog / any JSON)</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono break-all text-gray-800 dark:text-gray-200">{genericUrl}</code>
              <CopyButton text={genericUrl} />
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Alertmanager adapter (native webhook payload)</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono break-all text-gray-800 dark:text-gray-200">{alertmanagerUrl}</code>
              <CopyButton text={alertmanagerUrl} />
            </div>
          </div>
        </div>
      </Card>

      {/* Webhook token */}
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <KeyRound className="w-5 h-5 text-gray-500" />
          <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">Webhook token</h3>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          Generate an org-bound token carrying only the <code className="font-mono">reporting:ingest</code> scope for your
          incident tool to authenticate with (<code className="font-mono">Authorization: Bearer &lt;token&gt;</code>). To
          rotate, generate a new one and revoke the old token on the <a className="underline" href="/dashboard/tokens">API Tokens</a> page.
        </p>
        <Button onClick={requestToken} loading={creating || !!pendingCreate}>Generate webhook token</Button>

        {pendingCreate && (
          <StepUpModal
            action="Re-confirm your password to create a reporting webhook token."
            onConfirmed={executeCreate}
            onClose={() => setPendingCreate(null)}
          />
        )}

        {newToken && (
          <div className="mt-4 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200 mb-2">Copy your token now — it won&apos;t be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono break-all text-gray-800 dark:text-gray-200">{newToken}</code>
              <CopyButton text={newToken} />
            </div>
          </div>
        )}
      </Card>

      {/* Provider presets */}
      <Card>
        <h3 className="text-base font-medium text-gray-900 dark:text-gray-100 mb-3">Provider setup</h3>
        <FormField label="Provider" className="max-w-xs mb-3">
          <Select value={provider} onChange={(e) => setProvider(e.target.value as ProviderKey)}>
            <option value="alertmanager">Alertmanager (native)</option>
            <option value="pagerduty">PagerDuty</option>
            <option value="datadog">Datadog</option>
            <option value="generic">Generic (JSON)</option>
          </Select>
        </FormField>
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{guide.label} — POST to:</p>
        <div className="flex items-center gap-2 mb-3">
          <code className="flex-1 text-xs font-mono break-all text-gray-800 dark:text-gray-200">{guide.endpoint}</code>
          <CopyButton text={guide.endpoint} />
        </div>
        <ol className="list-decimal ml-5 space-y-1 text-sm text-gray-600 dark:text-gray-300">
          {guide.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      </Card>

      {/* Correlation window */}
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <Clock className="w-5 h-5 text-gray-500" />
          <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">Correlation window</h3>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          An incident is attributed to the most recent successful deploy that completed within this many hours before it
          opened. {settingsLoading ? 'Loading…' : (
            <>Currently <strong>{`${effectiveWindow}h`}</strong>{settings?.incidentWindowHours == null ? ' (default)' : ' (override)'}.</>
          )}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <FormField label="Window (hours)" className="w-40">
            <Input
              type="number" min={1} max={720}
              value={windowInput}
              placeholder={String(effectiveWindow)}
              onChange={(e) => setWindowInput(e.target.value)}
              disabled={savingWindow}
            />
          </FormField>
          <Button onClick={saveWindow} loading={savingWindow} disabled={!windowInput}>Save window</Button>
        </div>
      </Card>

      {/* Retention (Phase 7) — READ-ONLY (billing-owned) */}
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <Archive className="w-5 h-5 text-gray-500" />
          <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">Retention</h3>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          Reporting data is purged by age on a split schedule. Retention is part of your plan — raise it by adding a
          retention / DORA-History pack. DORA history is bounded by the DORA-source window; reports hard-cap at 730 days
          regardless, so a longer window preserves raw source rows within that ceiling.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Standard events</p>
            <p className="mt-0.5 text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
              {settingsLoading ? '…' : fmtRetentionDays(effectiveEventDays)}
            </p>
            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              {settings?.eventRetentionDays == null ? 'plan default' : 'from your plan / packs'}
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">DORA source</p>
            <p className="mt-0.5 text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
              {settingsLoading ? '…' : fmtRetentionDays(effectiveDoraDays)}
            </p>
            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              {settings?.doraRetentionDays == null ? 'plan default' : 'from your plan / packs'}
            </p>
          </div>
        </div>
        <Link href={RETENTION_PACK_HIGHLIGHT} className="btn btn-secondary btn-sm mt-3 inline-flex">
          Extend retention
        </Link>
      </Card>

      {/* Send test incident */}
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <FlaskConical className="w-5 h-5 text-gray-500" />
          <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">Send test incident</h3>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          A non-persisting dry-run: checks whether a synthetic incident opening now for the given environment would
          correlate to a recent successful deploy under your window. It does <strong>not</strong> write an incident or
          affect your metrics.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <FormField label="Environment" className="w-56">
            <Input value={testEnv} onChange={(e) => setTestEnv(e.target.value)} placeholder="production" disabled={testing} />
          </FormField>
          <Button onClick={sendTest} loading={testing}>Send test incident</Button>
        </div>
        {testResult && (
          <div className={`mt-3 rounded-lg border px-4 py-3 text-sm ${testResult.correlated
            ? 'border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200'
            : 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200'}`}>
            {testResult.correlated ? (
              <>Correlated to deploy <code className="font-mono">{testResult.executionId}</code> (completed {testResult.deployCompletedAt}). Window {testResult.windowHours}h.</>
            ) : (
              <>No successful deploy to <strong>{testResult.environment}</strong> in the last {testResult.windowHours}h. Confirm the environment name matches your deploy stage and that a deploy ran recently.</>
            )}
          </div>
        )}
      </Card>

      {/* Recent incidents */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">Recent incidents</h3>
          <Button variant="ghost" size="xs" onClick={() => void reloadIncidents()}>Refresh</Button>
        </div>
        {incidentsLoading && incidents.length === 0 ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : incidentsError && incidents.length === 0 ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300" role="alert">
            <span>{incidentsError}</span>
            <button type="button" onClick={() => void reloadIncidents()} className="underline hover:no-underline shrink-0">Retry</button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <DataTable
              data={incidents}
              columns={incidentColumns}
              isLoading={false}
              animated={false}
              getRowKey={(i) => i.incidentId}
              emptyState={{ icon: Siren, title: 'No incidents yet', description: 'Incidents will appear here once your tooling posts them.' }}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
