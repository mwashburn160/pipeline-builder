// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useId } from 'react';
import { AlertTriangle, BellOff, CheckCircle2, RefreshCw, Volume2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useFetch } from '@/hooks/useFetch';
import { usePolling } from '@/hooks/usePolling';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { useToast } from '@/components/ui/Toast';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { RetryError } from '@/components/ui/RetryError';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { WarningAlert } from '@/components/ui/WarningAlert';
import { api } from '@/lib/api';
import type { Alert, Silence } from '@/types/observability';
import { formatRelativeTime } from '@/lib/relative-time';
import { formatError } from '@/lib/constants';

const SEVERITY_STYLES: Record<string, { bg: string; text: string; chip: string }> = {
  critical: {
    bg: 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20',
    text: 'text-red-800 dark:text-red-200',
    chip: 'bg-red-600 text-white',
  },
  warning: {
    bg: 'border-yellow-300 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/20',
    text: 'text-yellow-800 dark:text-yellow-200',
    chip: 'bg-yellow-500 text-white',
  },
  info: {
    bg: 'border-blue-300 dark:border-blue-800 bg-info-bg',
    text: 'text-blue-800 dark:text-blue-200',
    chip: 'bg-blue-500 text-white',
  },
};

const DURATIONS = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '4 hours', ms: 4 * 60 * 60 * 1000 },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '3 days', ms: 3 * 24 * 60 * 60 * 1000 },
];

function severityOf(a: Alert): string {
  return a.labels.severity || 'info';
}

function styleFor(a: Alert): { bg: string; text: string; chip: string } {
  return SEVERITY_STYLES[severityOf(a)] || SEVERITY_STYLES.info;
}

export default function AlertsPage() {
  // Viewing alerts requires only `observability:read` (matches the catalog —
  // Members hold it). Alert triage (creating/expiring silences) is an
  // `observability:write` capability gated per-control via `can()`, which also
  // reports false under read-only impersonation (superadmins bypass).
  // (The `observability:read` page gate comes from page-access.)
  const { accessDenied, isReady, isAuthenticated, can } = useAuthGuard();
  const canWrite = can('observability:write');
  const toast = useToast();
  const ready = isReady && isAuthenticated;
  const [silenceTarget, setSilenceTarget] = useState<Alert | null>(null);
  // Expiring a silence re-arms its alerts immediately — confirm first.
  const [expireTarget, setExpireTarget] = useState<Silence | null>(null);
  const [expiring, setExpiring] = useState(false);

  const { data, loading, error, refetch } = useFetch(
    async (signal) => {
      if (!ready) return null;
      const [alertsRes, silencesRes] = await Promise.all([
        api.observabilityAlerts(signal),
        api.observabilitySilences(signal),
      ]);
      return {
        alerts: alertsRes.data?.alerts ?? [],
        silences: silencesRes.data?.silences ?? [],
        // True when the backend returned a degraded (empty) result because
        // Alertmanager was unreachable — e.g. a LEAN deploy that omits it.
        // Distinguishes "no alerts" from "can't see alerts" so an empty panel
        // isn't misread as all-clear.
        degraded: Boolean(alertsRes.data?.degraded || silencesRes.data?.degraded),
      };
    },
    [ready],
  );
  const alerts: Alert[] = data?.alerts ?? [];
  const silences: Silence[] = data?.silences ?? [];
  const degraded = data?.degraded ?? false;

  // Poll every 30 s while the tab is visible — Alertmanager itself evaluates
  // rules every 15 s, so this keeps the UI ~half a cycle behind which is fine
  // for an operator dashboard. Drop to 5 s if pager-level urgency is needed;
  // bump to 60 s+ if Prom/AM start to feel the load. The first read is
  // useFetch's own.
  usePolling(refetch, 30_000, { enabled: ready, immediate: false });

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !isAuthenticated) return <LoadingPage />;

  const activeSilences = silences.filter(s => s.status.state === 'active');

  // Sort: critical > warning > info > other; within severity, newest first.
  const sortedAlerts = [...alerts].sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 } as Record<string, number>;
    const da = order[severityOf(a)] ?? 99;
    const db = order[severityOf(b)] ?? 99;
    if (da !== db) return da - db;
    return b.startsAt.localeCompare(a.startsAt);
  });

  const onCreateSilence = async (matchers: Array<{ name: string; value: string }>, durationMs: number, comment: string) => {
    try {
      await api.observabilityCreateSilence({ matchers, durationMs, comment });
      toast.success('Silence created — alert will stop firing within ~15 s.');
      setSilenceTarget(null);
      refetch();
    } catch (err) {
      toast.error(formatError(err));
    }
  };

  const onExpireSilence = async () => {
    if (!expireTarget) return;
    setExpiring(true);
    try {
      await api.observabilityDeleteSilence(expireTarget.id);
      toast.success('Silence expired.');
      setExpireTarget(null);
      refetch();
    } catch (err) {
      toast.error(formatError(err));
    } finally {
      setExpiring(false);
    }
  };

  return (
    <DashboardLayout
      title="Alerts"
      subtitle="Firing + suppressed alerts from Alertmanager"
      actions={
        <Button
          variant="secondary"
          size="xs"
          onClick={refetch}
          className="gap-1"
          aria-label="Refresh alerts"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </Button>
      }
    >
      {loading && !data ? (
        <div className="text-sm text-fg-muted">Loading…</div>
      ) : error && !data ? (
        <RetryError message={formatError(error)} onRetry={refetch} />
      ) : (
        <div className="space-y-6">
          {error && <RetryError message={formatError(error)} onRetry={refetch} />}
          <WarningAlert
            message={degraded
              ? 'Monitoring backend unavailable — Alertmanager is not reachable (this deployment may be running in LEAN mode, which omits it). Alerts and silences can’t be shown.'
              : undefined}
          />
          {sortedAlerts.length === 0 ? (
            degraded ? null : (
              <EmptyState icon={CheckCircle2} title="No alerts firing" description="Nothing is firing or silenced for this org right now." />
            )
          ) : (
            <div className="space-y-2">
              {sortedAlerts.map((a) => {
                const styles = styleFor(a);
                const suppressed = a.status.state === 'suppressed';
                return (
                  <div key={a.fingerprint} className={`rounded border p-3 ${styles.bg}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded ${styles.chip}`}>
                            <AlertTriangle className="w-3 h-3" />
                            {severityOf(a).toUpperCase()}
                          </span>
                          {suppressed && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded bg-surface-muted text-fg-muted">
                              <BellOff className="w-3 h-3" /> silenced
                            </span>
                          )}
                          <span className={`text-sm font-semibold ${styles.text}`}>
                            {a.labels.alertname || 'Unnamed alert'}
                          </span>
                        </div>
                        {a.annotations.summary && (
                          <div className={`text-sm ${styles.text}`}>{a.annotations.summary}</div>
                        )}
                        {a.annotations.description && (
                          <div className="text-xs text-fg-muted mt-1">{a.annotations.description}</div>
                        )}
                        <div className="text-xs text-fg-muted mt-2 flex gap-3 flex-wrap">
                          <span>Since {formatRelativeTime(a.startsAt)}</span>
                          {Object.entries(a.labels)
                            .filter(([k]) => !['alertname', 'severity'].includes(k))
                            .map(([k, v]) => (
                              <span key={k} className="font-mono">{k}={v}</span>
                            ))}
                        </div>
                      </div>
                      {!suppressed && canWrite && (
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => setSilenceTarget(a)}
                          className="flex-shrink-0 gap-1"
                        >
                          <BellOff className="w-3 h-3" /> Silence
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {activeSilences.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-fg-muted mb-2 flex items-center gap-2">
                <Volume2 className="w-4 h-4" /> Active silences ({activeSilences.length})
              </h3>
              <div className="space-y-1">
                {activeSilences.map((s) => (
                  <div key={s.id} className="rounded border border-default bg-surface px-3 py-2 text-xs flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-fg-muted truncate">
                        {s.matchers.map(m => `${m.name}="${m.value}"`).join(', ')}
                      </div>
                      <div className="text-fg-muted mt-0.5">
                        {s.comment} — by {s.createdBy} — expires {formatRelativeTime(s.endsAt)}
                      </div>
                    </div>
                    {canWrite && (
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => setExpireTarget(s)}
                        className="flex-shrink-0"
                      >
                        Expire
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {expireTarget && (
        <ConfirmDialog
          title="Expire silence?"
          confirmLabel="Expire silence"
          tone="danger"
          loading={expiring}
          onConfirm={() => void onExpireSilence()}
          onCancel={() => setExpireTarget(null)}
        >
          <p className="text-sm">
            Alerts matching{' '}
            <code className="font-mono text-xs break-all">
              {expireTarget.matchers.map((m) => `${m.name}="${m.value}"`).join(', ')}
            </code>{' '}
            will start notifying again straight away. This can&apos;t be undone — you would need to create a new silence.
          </p>
        </ConfirmDialog>
      )}

      {silenceTarget && (
        <SilenceModal
          alert={silenceTarget}
          onClose={() => setSilenceTarget(null)}
          onSubmit={onCreateSilence}
        />
      )}
    </DashboardLayout>
  );
}

/** Modal for creating a silence on a specific firing alert. */
function SilenceModal(props: {
  alert: Alert;
  onClose: () => void;
  onSubmit: (matchers: Array<{ name: string; value: string }>, durationMs: number, comment: string) => Promise<void>;
}) {
  const uid = useId();
  const { alert, onClose, onSubmit } = props;
  // Seed matchers with `alertname` + any org_id label so the silence narrows
  // to this specific alert in this org rather than every alert of any name.
  const seedMatchers = [
    { name: 'alertname', value: alert.labels.alertname || '' },
    ...(alert.labels.org_id ? [{ name: 'org_id', value: alert.labels.org_id }] : []),
  ].filter(m => m.value);

  const [durationMs, setDurationMs] = useState(DURATIONS[0].ms);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!comment.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit(seedMatchers, durationMs, comment.trim());
    } finally {
      setSubmitting(false);
    }
  };

  const footer = (
    <div className="flex justify-end gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={onClose}
        disabled={submitting}
      >
        Cancel
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={() => void handleSubmit()}
        disabled={submitting || !comment.trim()}
      >
        {submitting ? 'Creating…' : 'Create silence'}
      </Button>
    </div>
  );

  return (
    <Modal title="Silence alert" onClose={onClose} maxWidth="max-w-md" footer={footer}>
      <div className="space-y-4">
        <div>
          <div className="text-xs font-medium text-fg-muted mb-1">Matchers</div>
          <div className="text-xs font-mono text-fg-muted break-all">
            {seedMatchers.map(m => `${m.name}="${m.value}"`).join(', ')}
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-fg-muted mb-1" htmlFor={`${uid}-duration`}>Duration</label>
          <Select id={`${uid}-duration`}
            value={durationMs}
            onChange={(e) => setDurationMs(parseInt(e.target.value, 10))}
          >
            {DURATIONS.map(d => <option key={d.ms} value={d.ms}>{d.label}</option>)}
          </Select>
        </div>
        <div>
          <label className="block text-xs font-medium text-fg-muted mb-1" htmlFor={`${uid}-reason`}>
            Reason <span className="text-danger">*</span>
          </label>
          <Textarea id={`${uid}-reason`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="Why are you silencing this? (visible to other operators)"
          />
        </div>
      </div>
    </Modal>
  );
}
