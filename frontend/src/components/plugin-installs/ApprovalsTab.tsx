// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { RetryError } from '@/components/ui/RetryError';
import { LoadingSpinner } from '@/components/ui/Loading';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { FormField } from '@/components/ui/FormField';
import { Textarea } from '@/components/ui/Textarea';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import { TrustTierBadge } from '@/components/public-directory/TrustTierBadge';
import { useFetch } from '@/hooks/useFetch';
import { clearPluginCache } from '@/hooks/usePlugins';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { pluginPagePath } from '@/lib/public-directory/links';
import { VERSION_POLICY_LABELS } from '@/lib/plugin-installs';
import type { InstallChangeRequestView, InstallView } from '@/types/plugin-installs';

/**
 * Pending install requests (§3.2): members holding `plugins:install` request
 * an install when the org's policy wants approval for the publisher's tier;
 * holders of `plugin_installs:manage` approve or deny here, and the requester
 * is notified either way. Rendered only for `plugin_installs:manage`.
 */
export function ApprovalsTab({ onDecided }: { onDecided?: () => void }) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denying, setDenying] = useState<InstallView | null>(null);

  const list = useFetch(async (signal): Promise<InstallView[]> => {
    const res = await api.listPluginInstalls({ status: 'pending_approval' }, { signal });
    return res.data?.installs ?? [];
  }, []);
  const pending = (list.data ?? []).filter((i) => i.status === 'pending_approval' && i.id);

  const decide = async (install: InstallView, fn: () => Promise<unknown>, done: string) => {
    setBusyId(install.id);
    setError(null);
    try {
      await fn();
      toast.success(done);
      clearPluginCache();
      list.refetch();
      onDecided?.();
    } catch (e) {
      setError(formatError(e, 'Could not decide the request'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6" data-testid="approvals-tab">
    <div className="space-y-4">
      {error && <ErrorAlert message={error} onDismiss={() => setError(null)} />}
      {list.error && !list.data ? (
        <RetryError message={formatError(list.error, 'Could not load install requests')} onRetry={list.refetch} />
      ) : list.loading && !list.data ? (
        <div className="flex items-center gap-2 py-6 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading requests…</div>
      ) : pending.length === 0 ? (
        <EmptyState icon={Inbox} title="No pending install requests" description="Requests appear here when a member asks to install a plugin your policy requires approval for." />
      ) : (
        <ul className="divide-y divide-default rounded-xl border border-default" aria-label="Pending install requests">
          {pending.map((install) => (
            <li key={install.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between" data-testid="approval-row">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={pluginPagePath(install.publisherHandle, install.name)} className="font-mono text-sm font-semibold text-fg hover:text-brand hover:underline">
                    {install.publisherHandle}/{install.name}
                  </Link>
                  <TrustTierBadge tier={install.publisherTier} />
                </div>
                <p className="text-xs text-fg-muted">
                  Requested{install.installedBy ? ` by ${install.installedBy}` : ''}
                  {install.createdAt ? <> <RelativeTime value={install.createdAt} /></> : null}
                  {' · '}{VERSION_POLICY_LABELS[install.versionPolicy]}
                  {install.pinnedVersion ? ` from v${install.pinnedVersion}` : ''}
                </p>
                {install.summary && <p className="text-sm text-fg">{install.summary}</p>}
                {install.blocked && <p className="text-xs text-danger-strong">{install.blocked.message}</p>}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  loading={busyId === install.id}
                  onClick={() => void decide(install, () => api.approvePluginInstall(install.id as string), `Approved ${install.name}`)}
                >
                  Approve
                </Button>
                <Button size="sm" variant="secondary" disabled={busyId === install.id} onClick={() => setDenying(install)}>Deny</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {denying && (
        <DenyDialog
          install={denying}
          onClose={() => setDenying(null)}
          onDeny={(reason) => decide(denying, () => api.denyPluginInstall(denying.id as string, reason || undefined), `Denied ${denying.name}`)}
        />
      )}
    </div>
    <ChangeRequests onDecided={onDecided} />
    </div>
  );
}

/**
 * Requested install CHANGES (a major / breaking upgrade, or a move to `latest`,
 * that the requester's policy tier needs an approver for) — oldest first, beside
 * the install requests. Approving applies the change (re-validated server-side);
 * rejecting drops it and tells the requester why.
 */
function ChangeRequests({ onDecided }: { onDecided?: () => void }) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<InstallChangeRequestView | null>(null);
  const list = useFetch(async (signal): Promise<InstallChangeRequestView[]> => {
    const res = await api.listInstallChangeRequests({ signal });
    return res.data?.changeRequests ?? [];
  }, []);
  const rows = list.data ?? [];

  const decide = async (row: InstallChangeRequestView, fn: () => Promise<unknown>, done: string) => {
    setBusyId(row.installId);
    setError(null);
    try {
      await fn();
      toast.success(done);
      clearPluginCache();
      list.refetch();
      onDecided?.();
    } catch (e) {
      setError(formatError(e, 'Could not decide the change'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="change-requests-heading">
      <h3 id="change-requests-heading" className="text-sm font-semibold text-fg">Requested install changes</h3>
      {error && <ErrorAlert message={error} onDismiss={() => setError(null)} />}
      {list.error && !list.data ? (
        <RetryError message={formatError(list.error, 'Could not load change requests')} onRetry={list.refetch} />
      ) : list.loading && !list.data ? (
        <div className="flex items-center gap-2 py-4 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading change requests…</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No install changes are waiting for approval.</p>
      ) : (
        <ul className="divide-y divide-default rounded-xl border border-default" aria-label="Requested install changes">
          {rows.map((row) => (
            <li key={row.installId} className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between" data-testid="change-request-row">
              <div className="min-w-0 space-y-1">
                <p className="font-mono text-sm font-semibold text-fg">{row.listing}</p>
                <p className="text-xs text-fg-muted">
                  {row.from.version ? `v${row.from.version}` : 'current'} · {VERSION_POLICY_LABELS[row.from.versionPolicy]}
                  {' → '}v{row.to.version} · {VERSION_POLICY_LABELS[row.to.versionPolicy]}
                </p>
                <p className="text-xs text-fg-subtle">
                  Requested by {row.requestedBy} <RelativeTime value={row.requestedAt} />
                </p>
                {row.note && <p className="text-sm text-fg">“{row.note}”</p>}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  loading={busyId === row.installId}
                  onClick={() => void decide(row, () => api.approveInstallChange(row.installId), `Approved the change to ${row.listing}`)}
                  aria-label={`Approve the change to ${row.listing}`}
                >
                  Approve
                </Button>
                <Button size="sm" variant="secondary" disabled={busyId === row.installId} onClick={() => setRejecting(row)} aria-label={`Reject the change to ${row.listing}`}>
                  Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {rejecting && (
        <ReasonDialog
          title={`Reject the change to ${rejecting.listing}?`}
          confirmLabel="Reject"
          onClose={() => setRejecting(null)}
          onConfirm={(reason) => decide(rejecting, () => api.rejectInstallChange(rejecting.installId, reason || undefined), `Rejected the change to ${rejecting.listing}`)}
        />
      )}
    </section>
  );
}

function ReasonDialog({ title, confirmLabel, onConfirm, onClose }: {
  title: string;
  confirmLabel: string;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      dirty={reason.trim().length > 0}
      footer={(
        <ModalFooter
          onCancel={onClose}
          confirmLabel={confirmLabel}
          confirmVariant="danger"
          loading={busy}
          onConfirm={() => {
            setBusy(true);
            void onConfirm(reason.trim()).finally(() => { setBusy(false); onClose(); });
          }}
        />
      )}
    >
      <FormField label="Reason (optional)" hint="Sent to the requester.">
        <Textarea aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} />
      </FormField>
    </Modal>
  );
}

function DenyDialog({ install, onDeny, onClose }: {
  install: InstallView;
  onDeny: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`Deny ${install.name}?`}
      onClose={onClose}
      dirty={reason.trim().length > 0}
      footer={(
        <ModalFooter
          onCancel={onClose}
          confirmLabel="Deny"
          confirmVariant="danger"
          loading={busy}
          onConfirm={() => {
            setBusy(true);
            void onDeny(reason.trim()).finally(() => { setBusy(false); onClose(); });
          }}
        />
      )}
    >
      <FormField label="Reason (optional)" hint="Sent to the requester.">
        <Textarea aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
      </FormField>
    </Modal>
  );
}
