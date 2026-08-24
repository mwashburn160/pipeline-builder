// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { SecretReveal } from '@/components/ui/SecretReveal';
import { RetryError } from '@/components/ui/RetryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FormField } from '@/components/ui/FormField';
import { Badge } from '@/components/ui/Badge';
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
    <SectionCard
      icon={KeyRound}
      title="Personal access tokens"
      description="Named, long-lived tokens for CLI and automation. Unlike session tokens, each can be revoked individually."
    >
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
        <SecretReveal value={newToken} label="Personal access token" className="mb-4" />
      )}

      {loading && pats.length === 0 ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
      ) : loadError && pats.length === 0 ? (
        <RetryError message={loadError} onRetry={() => void load()} />
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
    </SectionCard>
  );
}
