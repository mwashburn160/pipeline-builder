// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SectionCard } from '@/components/ui/SectionCard';
import { SecretReveal } from '@/components/ui/SecretReveal';
import { RetryError } from '@/components/ui/RetryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FormField } from '@/components/ui/FormField';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { AccessKeyTable, type KeyRow } from '@/components/settings/AccessKeyTable';
import { TokenPermissionPicker, permissionsForRequest } from '@/components/settings/TokenPermissionPicker';
import { readOnlyPreset, type PermissionMode } from '@/components/settings/token-scopes';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';

/**
 * Access-key management: the one place a person mints, reviews and revokes the
 * opaque `pb_pat_…` credentials their CLI / CI / integrations authenticate with.
 *
 * The key is shown EXACTLY once, at creation — only its hash is stored, so the
 * list can never show more than `pb_pat_…last4`. Everything else the page shows
 * (scope, expiry, last used, where it was created) comes from the key's record,
 * and "last used" is accurate wherever the key is used: every service trades
 * the key at platform, and that exchange is what stamps it.
 *
 * The rows themselves are {@link AccessKeyTable}, shared with the service
 * accounts panel so a machine key is reviewed with the same hygiene flags as a
 * personal one.
 *
 * CONFIRMATION RULE. Creating a key mints a durable credential and the server
 * gates it on step-up, so the single dialog confirms AND steps up. Revoking only
 * ever REMOVES access and the server deliberately does not gate it (a
 * compromised key must be killable without a second factor), so revoking is a
 * plain confirm — one dialog either way, never two.
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
  // useFetch keeps prior `keys` on failure and surfaces `loadError`.
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
  const { data: keysLoaded, loading, error: loadErrorFailure, refetch: load } = useFetch<KeyRow[]>(() => loadKeys(), [loadKeys], {
    onError: (err) => toast.error(formatError(err, 'Failed to load access keys')),
  });
  const keys = keysLoaded ?? [];
  const loadError = loadErrorFailure ? formatError(loadErrorFailure, 'Failed to load access keys') : null;
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  // New keys default to SELECTED permissions, seeded with the read-only preset:
  // least privilege is the path of least resistance, full access a deliberate
  // choice. Re-seeded when the profile's permissions arrive.
  const held = user?.permissions ?? [];
  const [permMode, setPermMode] = useState<PermissionMode>('selected');
  const [selectedPerms, setSelectedPerms] = useState<Set<string> | null>(null);
  const selected = selectedPerms ?? new Set(readOnlyPreset(held));
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  // Revoking is immediate and irreversible — a live key in CI stops working
  // within one token lifetime, and there's no restore panel for keys.
  const [pendingRevoke, setPendingRevoke] = useState<KeyRow | null>(null);
  // Creating a key is step-up gated (it mints a long-lived credential). Hold the
  // validated request until the user re-confirms in StepUpModal.
  const [pendingCreate, setPendingCreate] = useState<{ name: string; expiresIn: number; permissions?: string[] } | null>(null);

  // Validate, then hand off to the step-up modal — the actual create runs in
  // executeCreate once the user re-confirms.
  const handleCreate = () => {
    if (!name.trim()) { toast.error('Name is required'); return; }
    const d = Math.floor(Number(days));
    if (!Number.isFinite(d) || d < 1 || d > 365) { toast.error('Expiry must be 1–365 days'); return; }
    const permissions = permissionsForRequest(permMode, selected);
    if (permissions && permissions.length === 0) { toast.error('Choose at least one permission, or full access'); return; }
    setPendingCreate({ name: name.trim(), expiresIn: d * 86400, ...(permissions ? { permissions } : {}) });
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
        setPermMode('selected');
        setSelectedPerms(null);
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
      else {toast.error('Failed to revoke access key');}
    } catch (err) {
      toast.error(formatError(err, 'Failed to revoke access key'));
    } finally {
      setRevoking(null);
    }
  };

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
      <div className="mb-4">
        <TokenPermissionPicker
          mode={permMode}
          onModeChange={setPermMode}
          selected={selected}
          onSelectedChange={setSelectedPerms}
          held={held}
          disabled={creating || readOnly}
        />
      </div>

      {pendingCreate && (
        <StepUpModal
          title="Create an access key?"
          action={`Create the access key “${pendingCreate.name}”`}
          details={(
            <p>
              It is a long-lived credential that can act as you wherever it is used
              {pendingCreate.permissions
                ? <> — limited to {pendingCreate.permissions.length} selected permission{pendingCreate.permissions.length === 1 ? '' : 's'}</>
                : <>, with <strong>full access</strong> to everything you can do</>}
              , and it is shown exactly once — on the next screen.
            </p>
          )}
          onConfirmed={executeCreate}
          onClose={() => setPendingCreate(null)}
        />
      )}

      {newKey && (
        <SecretReveal
          value={newKey}
          label="Access key — copy it now, it is never shown again"
          filename="pipeline-builder-access-key.txt"
          onDone={() => setNewKey(null)}
          className="mb-4"
        />
      )}

      {loading && keys.length === 0 ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
      ) : loadError && keys.length === 0 ? (
        <RetryError message={loadError} onRetry={() => void load()} />
      ) : (
        <AccessKeyTable
          keys={keys}
          readOnly={readOnly}
          revokingId={revoking}
          onRevoke={setPendingRevoke}
        />
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
            <strong className="text-fg">{pendingRevoke.name}</strong> stops working within
            five minutes. Anything using it — CI jobs, scripts, the CLI — starts failing until it&apos;s replaced.
          </p>
          <p className="text-danger">This cannot be undone; issue a new key instead.</p>
        </ConfirmDialog>
      )}
    </SectionCard>
  );
}
