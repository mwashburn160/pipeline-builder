// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { AlertTriangle, Clock, KeyRound, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
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
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useLoadable } from '@/hooks/useLoadable';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { AccessKeyMeta } from '@/lib/api/domains/auth';

/** A key row with the service account that owns it (absent for a personal key). */
interface KeyRow extends AccessKeyMeta {
  /** The account id a service-account key belongs to — the revoke handle. */
  ownerAccountId?: string;
}

const STATUS_COLOR: Record<AccessKeyMeta['status'], 'green' | 'gray' | 'red'> = {
  active: 'green',
  expired: 'gray',
  revoked: 'red',
};

/**
 * Access-key management: the one place a person mints, reviews and revokes the
 * opaque `pb_pat_…` credentials their CLI / CI / integrations authenticate with.
 *
 * The key is shown EXACTLY once, at creation — only its hash is stored, so the
 * list can never show more than `pb_pat_…last4`. Everything else the page shows
 * (scope, expiry, last used, where it was created) comes from the key's record,
 * and "last used" is now accurate wherever the key is used: every service trades
 * the key at platform, and that exchange is what stamps it.
 *
 * Two hygiene flags are surfaced inline because they are what an audit actually
 * asks about: a key that has NEVER been used (mint-and-forget, pure risk) and
 * one EXPIRING SOON (about to break a pipeline at 3am).
 *
 * The list is the ONE place every key a person can see lives, so it also carries
 * the org's SERVICE-ACCOUNT keys (`pb_sa_…`) when the caller may manage them —
 * labelled with their owning account, revocable here, but only ever CREATED on
 * the service-accounts page, since those belong to the org rather than to anyone.
 *
 * `readOnly` (read-only impersonation) disables create + revoke — both writes
 * the backend rejects in that session.
 */
export function AccessKeysSection({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  // A load failure must NOT render as "no keys yet" — on a security surface a
  // false-empty could imply the account has no live credentials when it may.
  // useLoadable keeps prior `keys` on failure and surfaces `loadError`.
  const { user, can } = useAuthGuard();
  // Service-account keys are only listed for someone who may manage them; for
  // everyone else the page is exactly their own keys, as before.
  const orgId = user?.organizationId;
  const canManageServiceAccounts = can('service_accounts:manage');
  const loadKeys = useCallback(async (): Promise<KeyRow[]> => {
    const res = await api.listAccessKeys();
    if (!res.success || !res.data) throw new Error('Failed to load access keys');
    const rows: KeyRow[] = [...res.data.keys];
    if (canManageServiceAccounts && orgId) {
      // A failure here must NOT blank the person's own keys: their list is the
      // load-bearing part of this page, and the service-accounts page is where
      // machine keys are managed anyway.
      try {
        const accounts = await api.listServiceAccounts(orgId);
        if (accounts.success && accounts.data) {
          for (const account of accounts.data.serviceAccounts) {
            for (const key of account.keys) rows.push({ ...key, ownerAccountId: account.id });
          }
        }
      } catch {
        // Ignored deliberately — see above.
      }
    }
    return rows;
  }, [canManageServiceAccounts, orgId]);
  const { data: keys, loading, error: loadError, reload: load } = useLoadable<KeyRow[]>(loadKeys, [], 'Failed to load access keys');
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  // Revoking is immediate and irreversible — a live key in CI stops working
  // within one token lifetime, and there's no restore panel for keys.
  const [pendingRevoke, setPendingRevoke] = useState<KeyRow | null>(null);
  // Creating a key is step-up gated (it mints a long-lived credential). Hold the
  // validated request until the user re-confirms in StepUpModal.
  const [pendingCreate, setPendingCreate] = useState<{ name: string; expiresIn: number } | null>(null);

  // Validate, then hand off to the step-up modal — the actual create runs in
  // executeCreate once the user re-confirms.
  const handleCreate = () => {
    if (!name.trim()) { toast.error('Name is required'); return; }
    const d = Math.floor(Number(days));
    if (!Number.isFinite(d) || d < 1 || d > 365) { toast.error('Expiry must be 1–365 days'); return; }
    setPendingCreate({ name: name.trim(), expiresIn: d * 86400 });
  };

  const executeCreate = async (stepUpToken: string) => {
    if (!pendingCreate) return;
    setCreating(true);
    setNewKey(null);
    try {
      const res = await api.createAccessKey(pendingCreate, stepUpToken);
      if (res.success && res.data) {
        setNewKey(res.data.key);
        setName('');
        toast.success('Access key created');
        void load();
      } else {
        toast.error('Failed to create access key');
      }
    } catch (err) {
      toast.error(formatError(err, 'Failed to create access key'));
    } finally {
      setCreating(false);
      setPendingCreate(null);
    }
  };

  const handleRevoke = async (key: KeyRow) => {
    const id = key.id;
    setRevoking(id);
    try {
      // A service-account key is revoked through its OWNING ACCOUNT's route:
      // it is org property, gated on `service_accounts:manage`, not on being
      // the signed-in person.
      const res = key.ownerAccountId && orgId
        ? await api.revokeServiceAccountKey(orgId, key.ownerAccountId, id)
        : await api.revokeAccessKey(id);
      if (res.success) { toast.success('Access key revoked'); void load(); }
      else toast.error('Failed to revoke access key');
    } catch (err) {
      toast.error(formatError(err, 'Failed to revoke access key'));
    } finally {
      setRevoking(null);
    }
  };

  const columns: Column<KeyRow>[] = [
    {
      id: 'name',
      header: 'Name',
      cellClassName: 'font-medium text-gray-900 dark:text-gray-100',
      render: (k) => (
        <div className="flex flex-col gap-0.5">
          <span>
            {k.name}
            {k.kind === 'service_account' && (
              <span className="ml-1 text-xs text-gray-400">
                (service account{k.serviceAccountName ? `: ${k.serviceAccountName}` : ''})
              </span>
            )}
          </span>
          <span className="font-mono text-xs text-gray-400">{k.display}</span>
        </div>
      ),
    },
    {
      id: 'scope',
      header: 'Scope',
      render: (k) => (k.scope
        ? <span className="font-mono text-xs">{k.scope}</span>
        : <span className="text-xs text-gray-400">full account access</span>),
    },
    {
      id: 'status',
      header: 'Status',
      render: (k) => (
        <div className="flex flex-wrap items-center gap-1">
          <Badge color={STATUS_COLOR[k.status]}>{k.status}</Badge>
          {/* Hygiene flags — only meaningful while the key is still live. */}
          {k.status === 'active' && k.neverUsed && (
            <span title="This key has never been used. If nothing needs it, revoke it.">
              <Badge color="yellow"><AlertTriangle className="w-3 h-3 mr-1 inline" />never used</Badge>
            </span>
          )}
          {k.expiringSoon && (
            <span title="Expires within 14 days — rotate it before whatever uses it starts failing.">
              <Badge color="yellow"><Clock className="w-3 h-3 mr-1 inline" />expiring soon</Badge>
            </span>
          )}
        </div>
      ),
    },
    {
      id: 'created',
      header: 'Created',
      render: (k) => (
        <div className="flex flex-col gap-0.5">
          <RelativeTime value={k.createdAt} />
          {k.createdFrom && <span className="text-xs text-gray-400">{k.createdFrom}</span>}
        </div>
      ),
    },
    { id: 'expires', header: 'Expires', render: (k) => <RelativeTime value={k.expiresAt} /> },
    {
      id: 'lastUsed',
      header: 'Last used',
      render: (k) => (k.lastUsedAt ? <RelativeTime value={k.lastUsedAt} /> : <span className="text-gray-400">never</span>),
    },
    {
      id: 'actions',
      header: '',
      cellClassName: 'text-right',
      render: (k) => (!k.revoked && k.status !== 'expired' ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setPendingRevoke(k)}
          readOnly={readOnly}
          disabled={revoking === k.id}
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
      title="Access keys"
      description="Opaque keys for the CLI, CI and integrations — your own (pb_pat_…) and, if you manage them, the organization's service-account keys (pb_sa_…). Each can be revoked on its own, and a revoked key stops working everywhere within five minutes."
    >
      <div className="flex flex-wrap items-end gap-2 mb-4">
        <FormField label="Name" className="flex-1 min-w-[180px]">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ci-deploy" maxLength={100} disabled={creating || readOnly} />
        </FormField>
        <FormField label="Expires (days)" className="w-32">
          <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={creating || readOnly} />
        </FormField>
        <Button onClick={handleCreate} loading={creating || !!pendingCreate} readOnly={readOnly}>Create key</Button>
      </div>

      {pendingCreate && (
        <StepUpModal
          action="Re-confirm your identity to create an access key."
          onConfirmed={executeCreate}
          onClose={() => setPendingCreate(null)}
        />
      )}

      {newKey && (
        <SecretReveal
          value={newKey}
          label="Access key — copy it now, it is never shown again"
          className="mb-4"
        />
      )}

      {loading && keys.length === 0 ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
      ) : loadError && keys.length === 0 ? (
        <RetryError message={loadError} onRetry={() => void load()} />
      ) : (
        <div className="overflow-x-auto">
          <DataTable
            data={keys}
            columns={columns}
            isLoading={false}
            animated={false}
            getRowKey={(k) => k.id}
            emptyState={{ icon: KeyRound, title: 'No access keys yet', description: 'Create a key above for the CLI, CI and integrations.' }}
          />
        </div>
      )}

      {pendingRevoke && (
        <ConfirmDialog
          title="Revoke access key?"
          confirmLabel="Revoke key"
          tone="danger"
          loading={revoking === pendingRevoke.id}
          onCancel={() => setPendingRevoke(null)}
          onConfirm={async () => {
            await handleRevoke(pendingRevoke);
            setPendingRevoke(null);
          }}
        >
          <p>
            <strong className="text-gray-800 dark:text-gray-100">{pendingRevoke.name}</strong> stops working within
            five minutes. Anything using it — CI jobs, scripts, the CLI — starts failing until it&apos;s replaced.
          </p>
          <p className="text-red-600 dark:text-red-400">This cannot be undone; issue a new key instead.</p>
        </ConfirmDialog>
      )}
    </SectionCard>
  );
}
