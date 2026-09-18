// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { Bot, KeyRound, Plus, Power, Trash2 } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Callout } from '@/components/ui/Callout';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SecretReveal } from '@/components/ui/SecretReveal';
import { RetryError } from '@/components/ui/RetryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { FormField } from '@/components/ui/FormField';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useLoadable } from '@/hooks/useLoadable';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { ServiceAccount, ServiceAccountBilling } from '@/lib/api/domains/organizations';
import type { OrganizationRole } from '@/types';

/** What the page loads in one go: the accounts plus the org's role catalog. */
interface ServiceAccountsData {
  accounts: ServiceAccount[];
  billing: ServiceAccountBilling | null;
  roles: OrganizationRole[];
}

const EMPTY: ServiceAccountsData = { accounts: [], billing: null, roles: [] };

/**
 * Capability scopes a key may carry INSTEAD of the account's roles (#12). A
 * scoped key exchanges to a token with no permissions at all, so it can do the
 * one thing named here and nothing else — which is what every automation that
 * does exactly one thing should hold. Mirrors api-core's `TOKEN_SCOPES`; a value
 * outside that catalog is refused by the API.
 */
const KEY_SCOPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'reporting:ingest', label: 'reporting:ingest — post pipeline events / incidents' },
  { value: 'registry:push', label: 'registry:push — push images to this org’s namespace' },
  { value: 'scim', label: 'scim — provision members from your identity provider (SCIM 2.0)' },
];

/** A pending step-up-gated action, held until the user re-confirms. */
type PendingAction =
  | { kind: 'create'; name: string; description?: string; roleIds: string[] }
  | { kind: 'key'; accountId: string; accountName: string; name: string; expiresIn: number; ipAllowlist: string[]; scope: string }
  | { kind: 'toggle'; accountId: string; disabled: boolean }
  | { kind: 'roles'; accountId: string; roleIds: string[] }
  | { kind: 'delete'; accountId: string; name: string };

/**
 * Org service accounts (#2): the page where an admin creates non-human
 * principals, gives them roles, and issues or revokes their `pb_sa_…` keys.
 *
 * Three properties the UI states rather than implies, because they are what
 * people get wrong about machine identities:
 *   - a service account takes NO seat and has its own token-exchange budget;
 *   - a key is shown exactly ONCE (only its hash is stored);
 *   - its roles can never exceed the permissions of whoever creates them —
 *     the backend refuses, and the picker only offers the org's roles.
 *
 * Every write is step-up gated, exactly like creating a personal access key, so
 * each one routes through StepUpModal before it is sent.
 */
export function ServiceAccountsSection({ orgId, readOnly }: { orgId: string; readOnly: boolean }) {
  const toast = useToast();

  const load = useCallback(async (): Promise<ServiceAccountsData> => {
    const [accountsRes, rolesRes] = await Promise.all([
      api.listServiceAccounts(orgId),
      api.getOrganizationRoles(orgId),
    ]);
    if (!accountsRes.success || !accountsRes.data) throw new Error('Failed to load service accounts');
    return {
      accounts: accountsRes.data.serviceAccounts,
      billing: accountsRes.data.billing,
      roles: rolesRes.success && rolesRes.data ? rolesRes.data.roles : [],
    };
  }, [orgId]);
  const { data, loading, error: loadError, reload } = useLoadable<ServiceAccountsData>(load, EMPTY, 'Failed to load service accounts');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [keyDraft, setKeyDraft] = useState<{ accountId: string; name: string; days: number; ips: string; scope: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ServiceAccount | null>(null);
  const [pendingKeyRevoke, setPendingKeyRevoke] = useState<{ account: ServiceAccount; keyId: string; keyName: string } | null>(null);

  const toggleRole = (id: string) => setRoleIds((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));

  const handleCreate = () => {
    const trimmed = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(trimmed)) {
      toast.error('Name must be 2-64 characters: lowercase letters, digits, hyphen or underscore');
      return;
    }
    setPending({ kind: 'create', name: trimmed, description: description.trim() || undefined, roleIds });
  };

  const handleKeyCreate = () => {
    if (!keyDraft) return;
    if (!keyDraft.name.trim()) { toast.error('Key name is required'); return; }
    const days = Math.floor(Number(keyDraft.days));
    if (!Number.isFinite(days) || days < 1 || days > 365) { toast.error('Expiry must be 1-365 days'); return; }
    const account = data.accounts.find((a) => a.id === keyDraft.accountId);
    setPending({
      kind: 'key',
      accountId: keyDraft.accountId,
      accountName: account?.name ?? '',
      name: keyDraft.name.trim(),
      expiresIn: days * 86400,
      ipAllowlist: keyDraft.ips.split(',').map((s) => s.trim()).filter(Boolean),
      scope: keyDraft.scope,
    });
  };

  /** Run the held action with the freshly-minted step-up token. */
  const execute = async (stepUpToken: string) => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === 'create') {
        const res = await api.createServiceAccount(orgId, {
          name: pending.name,
          ...(pending.description ? { description: pending.description } : {}),
          roleIds: pending.roleIds,
        }, stepUpToken);
        if (res.success) {
          toast.success('Service account created');
          setName(''); setDescription(''); setRoleIds([]);
        } else toast.error('Failed to create service account');
      } else if (pending.kind === 'key') {
        setNewKey(null);
        const res = await api.createServiceAccountKey(orgId, pending.accountId, {
          name: pending.name,
          expiresIn: pending.expiresIn,
          ...(pending.ipAllowlist.length > 0 ? { ipAllowlist: pending.ipAllowlist } : {}),
          ...(pending.scope ? { scope: pending.scope } : {}),
        }, stepUpToken);
        if (res.success && res.data) {
          setNewKey(res.data.key);
          setKeyDraft(null);
          toast.success(`Key created for ${pending.accountName}`);
        } else toast.error('Failed to create key');
      } else if (pending.kind === 'toggle') {
        const res = await api.updateServiceAccount(orgId, pending.accountId, { disabled: pending.disabled }, stepUpToken);
        if (res.success) toast.success(pending.disabled ? 'Service account disabled' : 'Service account enabled');
        else toast.error('Failed to update service account');
      } else if (pending.kind === 'roles') {
        const res = await api.updateServiceAccount(orgId, pending.accountId, { roleIds: pending.roleIds }, stepUpToken);
        if (res.success) toast.success('Roles updated');
        else toast.error('Failed to update roles');
      } else {
        const res = await api.deleteServiceAccount(orgId, pending.accountId, stepUpToken);
        if (res.success) toast.success(`${pending.name} deleted`);
        else toast.error('Failed to delete service account');
      }
      await reload();
    } catch (err) {
      toast.error(formatError(err, 'Action failed'));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const revokeKey = async (account: ServiceAccount, keyId: string) => {
    setBusy(true);
    try {
      const res = await api.revokeServiceAccountKey(orgId, account.id, keyId);
      if (res.success) { toast.success('Key revoked'); await reload(); }
      else toast.error('Failed to revoke key');
    } catch (err) {
      toast.error(formatError(err, 'Failed to revoke key'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      icon={Bot}
      title="Service accounts"
      description="Non-human principals owned by this organization. They hold roles, sign in with nothing, authenticate with pb_sa_ keys — and take no seat."
    >
      {data.billing && (
        <Callout variant="neutral" className="mb-4">
          {data.billing.accounts} of {data.billing.maxAccounts} service accounts. Each one consumes{' '}
          <strong>no seat</strong> and has its own token budget, refreshed every {data.billing.budgetPeriodDays} days.
        </Callout>
      )}

      {/* Create */}
      <div className="flex flex-wrap items-end gap-2 mb-2">
        <FormField label="Name" className="flex-1 min-w-[180px]" hint="Lowercase machine name, e.g. ci-deploy">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ci-deploy" maxLength={64} disabled={busy || readOnly} />
        </FormField>
        <FormField label="Description" className="flex-1 min-w-[180px]">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Deploys from CI" maxLength={256} disabled={busy || readOnly} />
        </FormField>
        <Button onClick={handleCreate} loading={busy && pending?.kind === 'create'} readOnly={readOnly} className="gap-1">
          <Plus className="w-4 h-4" /> Create
        </Button>
      </div>
      {data.roles.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Roles for the new service account">
          {data.roles.map((role) => (
            <label key={role.id} className="inline-flex items-center gap-1.5 text-xs text-[var(--pb-text-muted)]">
              <input
                type="checkbox"
                checked={roleIds.includes(role.id)}
                onChange={() => toggleRole(role.id)}
                disabled={busy || readOnly}
              />
              {role.name}
            </label>
          ))}
        </div>
      )}

      {newKey && (
        <SecretReveal value={newKey} label="Service-account key — copy it now, it is never shown again" className="mb-4" />
      )}

      {loading && data.accounts.length === 0 ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
      ) : loadError && data.accounts.length === 0 ? (
        <RetryError message={loadError} onRetry={() => void reload()} />
      ) : data.accounts.length === 0 ? (
        <p className="text-sm text-[var(--pb-text-muted)]">No service accounts yet.</p>
      ) : (
        <div className="space-y-3">
          {data.accounts.map((account) => (
            <div key={account.id} className="rounded-lg border border-[var(--pb-border)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium text-sm">
                    {account.name}
                    {account.disabled && <Badge color="red" className="ml-2">disabled</Badge>}
                  </span>
                  <span className="text-xs text-[var(--pb-text-muted)]">
                    {account.description || 'No description'} · created by {account.createdByEmail ?? 'unknown'}
                    {account.lastUsedAt ? <> · last used <RelativeTime value={account.lastUsedAt} /></> : ' · never used'}
                  </span>
                  <span className="text-xs text-[var(--pb-text-muted)]">
                    {account.tokenBudget === -1
                      ? 'Unlimited token exchanges'
                      : `${account.usage.exchanges} / ${account.tokenBudget} token exchanges this period`}
                    {' · no seat'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="gap-1"
                    readOnly={readOnly}
                    disabled={busy}
                    onClick={() => setPending({ kind: 'toggle', accountId: account.id, disabled: !account.disabled })}
                  >
                    <Power className="w-3.5 h-3.5" /> {account.disabled ? 'Enable' : 'Disable'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="gap-1"
                    readOnly={readOnly}
                    disabled={busy}
                    onClick={() => setKeyDraft({ accountId: account.id, name: `${account.name}-key`, days: 90, ips: '', scope: '' })}
                  >
                    <KeyRound className="w-3.5 h-3.5" /> New key
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="gap-1 text-red-600 hover:text-red-700"
                    readOnly={readOnly}
                    disabled={busy}
                    onClick={() => setPendingDelete(account)}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </Button>
                </div>
              </div>

              {/* Roles — the account's authority, editable as a set. */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {data.roles.map((role) => {
                  const held = account.roles.some((r) => r.id === role.id);
                  return (
                    <label key={role.id} className="inline-flex items-center gap-1.5 text-xs text-[var(--pb-text-muted)]">
                      <input
                        type="checkbox"
                        checked={held}
                        disabled={busy || readOnly}
                        aria-label={`${role.name} for ${account.name}`}
                        onChange={() => setPending({
                          kind: 'roles',
                          accountId: account.id,
                          roleIds: held
                            ? account.roles.filter((r) => r.id !== role.id).map((r) => r.id)
                            : [...account.roles.map((r) => r.id), role.id],
                        })}
                      />
                      {role.name}
                    </label>
                  );
                })}
              </div>

              {/* Keys */}
              <div className="mt-3 space-y-1">
                {account.keys.length === 0 && <p className="text-xs text-[var(--pb-text-muted)]">No keys yet.</p>}
                {account.keys.map((key) => (
                  <div key={key.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono">{key.display}</span>
                      <span>{key.name}</span>
                      <Badge color={key.status === 'active' ? 'green' : key.status === 'expired' ? 'gray' : 'red'}>{key.status}</Badge>
                      {/* A scoped key acts with ONE capability and none of the account's
                          roles — the single most useful thing to see when deciding
                          whether a credential is over-privileged. */}
                      {key.scope && <Badge color="blue">{key.scope}</Badge>}
                      {key.ipAllowlist && <span className="text-[var(--pb-text-muted)]">IPs: {key.ipAllowlist.join(', ')}</span>}
                      <span className="text-[var(--pb-text-muted)]">expires <RelativeTime value={key.expiresAt} /></span>
                    </span>
                    {key.status === 'active' && (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-red-600 hover:text-red-700"
                        readOnly={readOnly}
                        disabled={busy}
                        onClick={() => setPendingKeyRevoke({ account, keyId: key.id, keyName: key.name })}
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New-key form (per account) */}
      {keyDraft && (
        <div className="mt-4 rounded-lg border border-[var(--pb-border)] p-3">
          <div className="flex flex-wrap items-end gap-2">
            <FormField label="Key name" className="flex-1 min-w-[160px]">
              <Input value={keyDraft.name} onChange={(e) => setKeyDraft({ ...keyDraft, name: e.target.value })} maxLength={100} />
            </FormField>
            <FormField label="Expires (days)" className="w-32">
              <Input type="number" min={1} max={365} value={keyDraft.days} onChange={(e) => setKeyDraft({ ...keyDraft, days: Number(e.target.value) })} />
            </FormField>
            <FormField label="IP allowlist" className="flex-1 min-w-[200px]" hint="Optional, comma-separated IPs or CIDRs">
              <Input value={keyDraft.ips} onChange={(e) => setKeyDraft({ ...keyDraft, ips: e.target.value })} placeholder="203.0.113.7, 10.0.0.0/8" />
            </FormField>
            <FormField
              label="Capability"
              className="min-w-[220px]"
              hint={keyDraft.scope
                ? 'Least privilege: this key can do only that, and carries none of the account’s roles.'
                : 'The key acts with the account’s full roles.'}
            >
              <Select value={keyDraft.scope} onChange={(e) => setKeyDraft({ ...keyDraft, scope: e.target.value })}>
                <option value="">Account roles (no scope)</option>
                {KEY_SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
            </FormField>
            <Button onClick={handleKeyCreate} loading={busy && pending?.kind === 'key'} readOnly={readOnly}>Issue key</Button>
            <Button variant="ghost" onClick={() => setKeyDraft(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {pending && (
        <StepUpModal
          action="Re-confirm your identity to change service-account access."
          onConfirmed={execute}
          onClose={() => setPending(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete service account?"
          confirmLabel="Delete"
          tone="danger"
          loading={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            setPending({ kind: 'delete', accountId: pendingDelete.id, name: pendingDelete.name });
            setPendingDelete(null);
          }}
        >
          <p>
            <strong className="text-gray-800 dark:text-gray-100">{pendingDelete.name}</strong> and all{' '}
            {pendingDelete.keys.length} of its keys are deleted. Anything authenticating as it stops working
            within five minutes.
          </p>
        </ConfirmDialog>
      )}

      {pendingKeyRevoke && (
        <ConfirmDialog
          title="Revoke key?"
          confirmLabel="Revoke key"
          tone="danger"
          loading={busy}
          onCancel={() => setPendingKeyRevoke(null)}
          onConfirm={async () => {
            await revokeKey(pendingKeyRevoke.account, pendingKeyRevoke.keyId);
            setPendingKeyRevoke(null);
          }}
        >
          <p>
            <strong className="text-gray-800 dark:text-gray-100">{pendingKeyRevoke.keyName}</strong> stops working
            within five minutes. Issue a replacement key first if the automation must keep running.
          </p>
        </ConfirmDialog>
      )}
    </SectionCard>
  );
}
