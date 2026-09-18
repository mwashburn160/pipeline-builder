// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { Laptop, Server, LogOut } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SectionCard } from '@/components/ui/SectionCard';
import { RetryError } from '@/components/ui/RetryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useToast } from '@/components/ui/Toast';
import { useLoadable } from '@/hooks/useLoadable';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { SessionMeta } from '@/lib/api/domains/auth';

/** How the sign-in behind a session was performed. */
const METHOD_LABEL: Record<string, string> = {
  pwd: 'Password',
  oauth: 'Social sign-in',
  sso: 'Single sign-on',
};

const EMPTY: { sessions: SessionMeta[]; machineSessions: SessionMeta[] } = { sessions: [], machineSessions: [] };

/**
 * Sessions and devices: the account's signed-in devices plus the stored machine
 * credentials `generate-token` (CLI `store-token`, the renewal Lambda) opened.
 *
 * Revoking is step-up gated, so it holds the selected session until the user
 * re-confirms — the same click-through the PAT create flow uses. The session
 * making the request is labelled "This device" and can't revoke itself (sign out
 * instead), matching the backend's refusal.
 *
 * `readOnly` (read-only impersonation) disables revoke — the write the backend
 * rejects in that session.
 */
export function SessionsSection({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  // A load failure must NOT render as "no sessions" — on a security surface a
  // false-empty reads as "nothing is signed in" when devices may well be.
  const loadSessions = useCallback(async () => {
    const res = await api.listSessions();
    if (res.success && res.data) return { sessions: res.data.sessions, machineSessions: res.data.machineSessions };
    throw new Error('Failed to load sessions');
  }, []);
  const { data, loading, error: loadError, reload } = useLoadable(loadSessions, EMPTY, 'Failed to load sessions');
  const [revoking, setRevoking] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<SessionMeta | null>(null);
  const [confirmed, setConfirmed] = useState<SessionMeta | null>(null);

  const executeRevoke = async (session: SessionMeta, stepUpToken: string) => {
    setRevoking(session.id);
    try {
      const res = await api.revokeSession(session.id, stepUpToken);
      if (res.success) {
        toast.success(session.kind === 'machine' ? 'Credential will no longer renew' : 'Device signed out');
        void reload();
      } else {
        toast.error('Failed to revoke session');
      }
    } catch (err) {
      toast.error(formatError(err, 'Failed to revoke session'));
    } finally {
      setRevoking(null);
      setConfirmed(null);
    }
  };

  const revokeColumn = (label: string): Column<SessionMeta> => ({
    id: 'actions',
    header: '',
    cellClassName: 'text-right',
    render: (s) => (s.current ? (
      <Badge color="green">This device</Badge>
    ) : (
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setPendingRevoke(s)}
        readOnly={readOnly}
        disabled={revoking === s.id}
        className="gap-1 text-red-600 hover:text-red-700"
      >
        <LogOut className="w-3.5 h-3.5" /> {label}
      </Button>
    )),
  });

  const deviceColumns: Column<SessionMeta>[] = [
    {
      id: 'client',
      header: 'Device',
      cellClassName: 'font-medium text-gray-900 dark:text-gray-100',
      render: (s) => s.userAgent ?? 'Unknown client',
    },
    {
      id: 'method',
      header: 'Signed in with',
      render: (s) => s.amr.map((m) => METHOD_LABEL[m] ?? m).join(', ') || '—',
    },
    { id: 'ip', header: 'Last IP', cellClassName: 'font-mono text-xs', render: (s) => s.lastIp ?? '—' },
    { id: 'signedIn', header: 'Signed in', render: (s) => <RelativeTime value={s.signedInAt} /> },
    { id: 'lastUsed', header: 'Last used', render: (s) => <RelativeTime value={s.lastUsedAt} /> },
    revokeColumn('Sign out'),
  ];

  const machineColumns: Column<SessionMeta>[] = [
    {
      id: 'scope',
      header: 'Scope',
      cellClassName: 'font-medium text-gray-900 dark:text-gray-100',
      render: (s) => (s.scope ? <span className="font-mono text-xs">{s.scope}</span> : 'Full access'),
    },
    { id: 'client', header: 'Created by', render: (s) => s.userAgent ?? 'Unknown client' },
    { id: 'ip', header: 'Last IP', cellClassName: 'font-mono text-xs', render: (s) => s.lastIp ?? '—' },
    { id: 'created', header: 'Created', render: (s) => <RelativeTime value={s.createdAt} /> },
    { id: 'renewed', header: 'Last renewed', render: (s) => <RelativeTime value={s.lastUsedAt} /> },
    revokeColumn('Stop renewal'),
  ];

  if (loading && data.sessions.length === 0 && data.machineSessions.length === 0) {
    return (
      <SectionCard icon={Laptop} title="Sessions and devices">
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
      </SectionCard>
    );
  }

  if (loadError && data.sessions.length === 0 && data.machineSessions.length === 0) {
    return (
      <SectionCard icon={Laptop} title="Sessions and devices">
        <RetryError message={loadError} onRetry={() => void reload()} />
      </SectionCard>
    );
  }

  return (
    <>
      <SectionCard
        icon={Laptop}
        title="Sessions and devices"
        description="Where your account is signed in. Signing a device out ends its session; the device has to sign in again."
      >
        <div className="overflow-x-auto">
          <DataTable
            data={data.sessions}
            columns={deviceColumns}
            isLoading={false}
            animated={false}
            getRowKey={(s) => s.id}
            emptyState={{ icon: Laptop, title: 'No signed-in devices', description: 'Sessions appear here as you sign in.' }}
          />
        </div>
      </SectionCard>

      <SectionCard
        icon={Server}
        title="Machine credentials"
        description="Long-lived tokens minted for automation (the CLI's store-token, CI, the renewal Lambda). Stopping renewal leaves the current token working until it expires — use “Sign out everywhere” to kill everything at once."
      >
        <div className="overflow-x-auto">
          <DataTable
            data={data.machineSessions}
            columns={machineColumns}
            isLoading={false}
            animated={false}
            getRowKey={(s) => s.id}
            emptyState={{ icon: Server, title: 'No machine credentials', description: 'Tokens from “Generate token” and the CLI appear here.' }}
          />
        </div>
      </SectionCard>

      {pendingRevoke && (
        <ConfirmDialog
          title={pendingRevoke.kind === 'machine' ? 'Stop renewing this credential?' : 'Sign this device out?'}
          confirmLabel={pendingRevoke.kind === 'machine' ? 'Stop renewal' : 'Sign out'}
          tone="danger"
          loading={revoking === pendingRevoke.id}
          onCancel={() => setPendingRevoke(null)}
          onConfirm={() => {
            setConfirmed(pendingRevoke);
            setPendingRevoke(null);
          }}
        >
          {pendingRevoke.kind === 'machine' ? (
            <p>
              The stored token stops renewing, so it lapses when it expires. Anything using it — CodeBuild image
              pulls, event ingestion — starts failing then unless a new one is stored.
            </p>
          ) : (
            <p>
              <strong className="text-gray-800 dark:text-gray-100">{pendingRevoke.userAgent ?? 'That client'}</strong>{' '}
              is signed out and has to sign in again.
            </p>
          )}
        </ConfirmDialog>
      )}

      {confirmed && (
        <StepUpModal
          action={confirmed.kind === 'machine'
            ? 'Re-confirm your password to stop this machine credential from renewing.'
            : 'Re-confirm your password to sign that device out.'}
          onConfirmed={(token) => executeRevoke(confirmed, token)}
          onClose={() => setConfirmed(null)}
        />
      )}
    </>
  );
}
