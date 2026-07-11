// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BellOff, RefreshCw, Volume2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { useToast } from '@/components/ui/Toast';
import { ModalPortal } from '@/components/ui/ModalPortal';
import { api, ApiError } from '@/lib/api';
import type { Alert, Silence } from '@/types/observability';
import { formatRelativeTime } from '@/lib/relative-time';

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
    bg: 'border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20',
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
  // Alert triage (creating/expiring silences) is an `observability:write`
  // capability (superadmins bypass).
  const { isReady, isAuthenticated } = useAuthGuard({ requirePermission: 'observability:write' });
  const toast = useToast();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [silences, setSilences] = useState<Silence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [silenceTarget, setSilenceTarget] = useState<Alert | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [alertsRes, silencesRes] = await Promise.all([
        api.observabilityAlerts(),
        api.observabilitySilences(),
      ]);
      setAlerts(alertsRes.data?.alerts ?? []);
      setSilences(silencesRes.data?.silences ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isReady || !isAuthenticated) return;
    void refresh();
    // Poll every 30 s — Alertmanager itself evaluates rules every 15 s, so this
    // keeps the UI ~half a cycle behind which is fine for an operator
    // dashboard. Drop to 5 s if pager-level urgency is needed; bump to 60 s+
    // if Prom/AM start to feel the load.
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [isReady, isAuthenticated, refresh]);

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
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const onExpireSilence = async (id: string) => {
    try {
      await api.observabilityDeleteSilence(id);
      toast.success('Silence expired.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <DashboardLayout
      title="Alerts"
      subtitle="Firing + suppressed alerts from Alertmanager"
      actions={
        <button
          onClick={() => void refresh()}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
          aria-label="Refresh alerts"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      }
    >
      {loading && alerts.length === 0 ? (
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>
      ) : error ? (
        <div className="rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200">
          {error}
        </div>
      ) : (
        <div className="space-y-6">
          {sortedAlerts.length === 0 ? (
            <div className="rounded border border-gray-200 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
              No alerts firing. ☀️
            </div>
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
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
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
                          <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">{a.annotations.description}</div>
                        )}
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-2 flex gap-3 flex-wrap">
                          <span>Since {formatRelativeTime(a.startsAt)}</span>
                          {Object.entries(a.labels)
                            .filter(([k]) => !['alertname', 'severity'].includes(k))
                            .map(([k, v]) => (
                              <span key={k} className="font-mono">{k}={v}</span>
                            ))}
                        </div>
                      </div>
                      {!suppressed && (
                        <button
                          onClick={() => setSilenceTarget(a)}
                          className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-white dark:hover:bg-gray-800"
                        >
                          <BellOff className="w-3 h-3" /> Silence
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {activeSilences.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
                <Volume2 className="w-4 h-4" /> Active silences ({activeSilences.length})
              </h3>
              <div className="space-y-1">
                {activeSilences.map((s) => (
                  <div key={s.id} className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-gray-700 dark:text-gray-300 truncate">
                        {s.matchers.map(m => `${m.name}="${m.value}"`).join(', ')}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400 mt-0.5">
                        {s.comment} — by {s.createdBy} — expires {formatRelativeTime(s.endsAt)}
                      </div>
                    </div>
                    <button
                      onClick={() => void onExpireSilence(s.id)}
                      className="flex-shrink-0 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      Expire
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
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

  return (
    <ModalPortal>
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal-panel max-w-md" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">Silence alert</h2>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Matchers</div>
            <div className="text-xs font-mono text-gray-700 dark:text-gray-300 break-all">
              {seedMatchers.map(m => `${m.name}="${m.value}"`).join(', ')}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Duration</label>
            <select
              value={durationMs}
              onChange={(e) => setDurationMs(parseInt(e.target.value, 10))}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              {DURATIONS.map(d => <option key={d.ms} value={d.ms}>{d.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              Reason <span className="text-red-500">*</span>
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              placeholder="Why are you silencing this? (visible to other operators)"
              className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
          </div>
        </div>
        <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4 bg-gray-50 dark:bg-gray-800/50 rounded-b-xl flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={submitting || !comment.trim()}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create silence'}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
