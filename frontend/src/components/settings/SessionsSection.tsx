// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { Laptop, Server, LogOut, ShieldOff } from 'lucide-react';
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
import { describeCredentialAuthority } from '@/components/settings/token-scopes';

/** How the sign-in behind a session was performed. */
const METHOD_LABEL: Record<string, string> = {
  pwd: 'Password',
  oauth: 'Social sign-in',
  sso: 'Single sign-on',
};

const EMPTY: { sessions: SessionMeta[]; machineSessions: SessionMeta[] } = { sessions: [], machineSessions: [] };

/** What the step-up dialog is currently gating. */
type Pending =
  | { kind: 'revoke'; session: SessionMeta }
  | { kind: 'revoke-all' };

/**
 * Sessions and devices: the account's signed-in devices plus the stored machine
 * credentials `generate-token` (CLI `store-token`, the renewal Lambda) opened —
 * and "Sign out everywhere", which ends all of them at once.
 *
 * CONFIRMATION RULE. Revoking is step-up gated server-side, so ONE dialog states
 * the consequence and takes the factor; the ConfirmDialog that used to precede
 * it asked the same question twice. The session making the request is labelled
 * "This device" and can't revoke itself (sign out instead), matching the
 * backend's refusal.
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
  const [revokingAll, setRevokingAll] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

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
    }
  };

  /** Kills every other session plus all CLI/PAT tokens; this tab is re-issued. */
  const executeRevokeAll = async (stepUpToken: string) => {
    setRevokingAll(true);
    try {
      await api.revokeAllTokens(stepUpToken);
      toast.success('Signed out everywhere. This tab has a fresh token.');
      void reload();
    } catch (err) {
      toast.error(formatError(err, 'Failed to revoke tokens'));
    } finally {
      setRevokingAll(false);
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
        onClick={() => setPending({ kind: 'revoke', session: s })}
        readOnly={readOnly}
        disabled={revoking === s.id}
        className="gap-1 text-danger hover:text-danger-strong"
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
      render: (s) => (s.scope
        ? <span className="font-mono text-xs">{s.scope}</span>
        : s.permissions
          ? <span title={describeCredentialAuthority(s)}>{s.permissions.length} selected permission{s.permissions.length === 1 ? '' : 's'}</span>
          : 'Full access'),
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

  const session = pending?.kind === 'revoke' ? pending.session : null;

  return (
    // Two cards, spaced by THIS component: the page wraps the section in a
    // single anchor element for deep links, so the parent's `space-y` no longer
    // reaches between them.
    <div className="space-y-6">
      <SectionCard
        icon={Laptop}
        title="Sessions and devices"
        description="Where your account is signed in. Signing a device out ends its session; the device has to sign in again."
        actions={(
          <Button
            variant="danger"
            size="sm"
            onClick={() => setPending({ kind: 'revoke-all' })}
            loading={revokingAll}
            readOnly={readOnly}
            className="flex-shrink-0 gap-1"
          >
            <ShieldOff className="w-4 h-4" /> Sign out everywhere
          </Button>
        )}
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

      {session && (
        <StepUpModal
          title={session.kind === 'machine' ? 'Stop renewing this credential?' : 'Sign this device out?'}
          action={session.kind === 'machine'
            ? 'Stop this machine credential from renewing'
            : `Sign out ${session.userAgent ?? 'that client'}`}
          details={session.kind === 'machine' ? (
            <p>
              The stored token stops renewing, so it lapses when it expires. Anything using it — CodeBuild image
              pulls, event ingestion — starts failing then unless a new one is stored.
            </p>
          ) : (
            <p>
              <strong className="text-gray-800 dark:text-gray-100">{session.userAgent ?? 'That client'}</strong>{' '}
              is signed out and has to sign in again.
            </p>
          )}
          onConfirmed={(token) => executeRevoke(session, token)}
          onClose={() => setPending(null)}
        />
      )}

      {pending?.kind === 'revoke-all' && (
        <StepUpModal
          title="Sign out everywhere?"
          action="Revoke every other session, CLI token and integration"
          details={(
            <p>
              Every other browser session, CLI token and integration credential stops working. This tab stays
              signed in with a fresh token; everything else has to sign in — or be re-issued — again.
            </p>
          )}
          onConfirmed={executeRevokeAll}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}
