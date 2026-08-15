// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
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
import type { PatMeta } from '@/lib/api/domains/auth';

const STATUS_COLOR: Record<PatMeta['status'], 'green' | 'gray' | 'red'> = {
  active: 'green',
  expired: 'gray',
  revoked: 'red',
};

/**
 * Personal Access Token management. Named, long-lived API credentials that —
 * unlike session tokens — can each be revoked individually (the server tracks
 * them by `jti`). The raw token is shown exactly once, at creation.
 */
export function PatSection() {
  const toast = useToast();
  // A load failure must NOT render as "no tokens yet" — on a security surface a
  // false-empty could imply the account has no live credentials when it may.
  // useLoadable keeps prior `pats` on failure and surfaces `loadError`.
  const loadPats = useCallback(async (): Promise<PatMeta[]> => {
    const res = await api.listPats();
    if (res.success && res.data) return res.data.pats;
    throw new Error('Failed to load tokens');
  }, []);
  const { data: pats, loading, error: loadError, reload: load } = useLoadable<PatMeta[]>(loadPats, [], 'Failed to load tokens');
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  // Creating a PAT is step-up gated (mints a long-lived credential). Hold the
  // validated request until the user re-confirms their password in StepUpModal.
  const [pendingCreate, setPendingCreate] = useState<{ name: string; expiresIn: number } | null>(null);

  // Validate, then hand off to the step-up modal — the actual create runs in
  // executeCreate once the user re-confirms their password.
  const handleCreate = () => {
    if (!name.trim()) { toast.error('Name is required'); return; }
    const d = Math.floor(Number(days));
    if (!Number.isFinite(d) || d < 1 || d > 365) { toast.error('Expiry must be 1–365 days'); return; }
    setPendingCreate({ name: name.trim(), expiresIn: d * 86400 });
  };

  const executeCreate = async (stepUpToken: string) => {
    if (!pendingCreate) return;
    setCreating(true);
    setNewToken(null);
    try {
      const res = await api.createPat(pendingCreate, stepUpToken);
      if (res.success && res.data) {
        setNewToken(res.data.token);
        setName('');
        toast.success('Token created');
        void load();
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

  const handleRevoke = async (jti: string) => {
    setRevoking(jti);
    try {
      const res = await api.revokePat(jti);
      if (res.success) { toast.success('Token revoked'); void load(); }
      else toast.error('Failed to revoke token');
    } catch (err) {
      toast.error(formatError(err, 'Failed to revoke token'));
    } finally {
      setRevoking(null);
    }
  };

  const columns: Column<PatMeta>[] = [
    {
      id: 'name',
      header: 'Name',
      cellClassName: 'font-medium text-gray-900 dark:text-gray-100',
      render: (p) => (
        <>{p.name}{p.scope ? <span className="ml-1 text-xs text-gray-400">({p.scope})</span> : null}</>
      ),
    },
    { id: 'status', header: 'Status', render: (p) => <Badge color={STATUS_COLOR[p.status]}>{p.status}</Badge> },
    { id: 'created', header: 'Created', render: (p) => <RelativeTime value={p.createdAt} /> },
    { id: 'expires', header: 'Expires', render: (p) => <RelativeTime value={p.expiresAt} /> },
    {
      id: 'lastUsed',
      header: 'Last used',
      render: (p) => (p.lastUsedAt ? <RelativeTime value={p.lastUsedAt} /> : <span className="text-gray-400">never</span>),
    },
    {
      id: 'actions',
      header: '',
      cellClassName: 'text-right',
      render: (p) => (!p.revoked && p.status !== 'expired' ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => handleRevoke(p.jti)}
          disabled={revoking === p.jti}
          className="gap-1 text-red-600 hover:text-red-700"
        >
          <Trash2 className="w-3.5 h-3.5" /> Revoke
        </Button>
      ) : null),
    },
  ];

  return (
    <Card>
      <div className="flex items-center gap-2 mb-2">
        <KeyRound className="w-5 h-5 text-gray-500" />
        <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">Personal Access Tokens</h2>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Named, long-lived tokens for CLI and automation. Unlike session tokens, each can be revoked individually.
      </p>

      <div className="flex flex-wrap items-end gap-2 mb-4">
        <FormField label="Name" className="flex-1 min-w-[180px]">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ci-deploy" maxLength={100} disabled={creating} />
        </FormField>
        <FormField label="Expires (days)" className="w-32">
          <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={creating} />
        </FormField>
        <Button onClick={handleCreate} loading={creating || !!pendingCreate}>Create token</Button>
      </div>

      {pendingCreate && (
        <StepUpModal
          action="Re-confirm your password to create a personal access token."
          onConfirmed={executeCreate}
          onClose={() => setPendingCreate(null)}
        />
      )}

      {newToken && (
        <div className="mb-4 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200 mb-2">Copy your token now — it won&apos;t be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono break-all text-gray-800 dark:text-gray-200">{newToken}</code>
            <CopyButton text={newToken} />
          </div>
        </div>
      )}

      {loading && pats.length === 0 ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : loadError && pats.length === 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => void load()} className="underline hover:no-underline shrink-0">Retry</button>
        </div>
      ) : pats.length === 0 ? (
        <p className="text-sm text-gray-400">No personal access tokens yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <DataTable
            data={pats}
            columns={columns}
            isLoading={false}
            animated={false}
            getRowKey={(p) => p.jti}
            emptyState={{ icon: KeyRound, title: 'No personal access tokens yet', description: 'Create a token above for CLI and automation.' }}
          />
        </div>
      )}
    </Card>
  );
}
