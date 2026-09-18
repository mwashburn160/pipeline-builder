// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { Check, Fingerprint, Pencil, Trash2, X } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SectionCard } from '@/components/ui/SectionCard';
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
import api from '@/lib/api';
import { browserSupportsWebAuthn, registerPasskey } from '@/lib/passkeys';
import { formatError } from '@/lib/constants';
import { webauthnErrorMessage } from '@/lib/webauthn';
import type { Passkey } from '@/types';

/**
 * Passkey management — where a person adds, relabels and revokes the WebAuthn
 * credentials they sign in and step up with.
 *
 * It sits in Settings → Security next to "Password", not next to API keys: a
 * passkey is a SIGN-IN credential for the person, while an access key is a
 * credential for a machine.
 *
 * Adding and removing are both step-up gated server-side, so both open a
 * `StepUpModal` first — which is also how an account with no password enrols its
 * FIRST passkey: step-up is factor-agnostic, so the modal offers "Sign in again
 * with <provider>" and that earns the same token.
 *
 * Removing the last thing you can sign in with is refused by the server
 * (`409`); the message is shown as-is rather than being re-derived here, so the
 * UI can't disagree with the rule that actually applies.
 *
 * Hidden entirely when the browser has no WebAuthn — there is nothing useful to
 * offer, and an "add" button that can only fail is worse than no button.
 * `readOnly` (read-only impersonation) disables both writes, matching the
 * backend's refusal.
 */
export function PasskeySection({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const [supported, setSupported] = useState<boolean | null>(null);
  // `browserSupportsWebAuthn` reads `window`, so it can only run after mount —
  // during SSR/hydration there is no navigator to ask.
  useEffect(() => { setSupported(browserSupportsWebAuthn()); }, []);

  // A load failure must NOT render as "no passkeys" — on a security surface a
  // false-empty reads as "nothing can sign in here" when something can.
  const loadPasskeys = useCallback(async (): Promise<Passkey[]> => {
    const res = await api.listPasskeys();
    if (!res.success || !res.data) throw new Error('Failed to load passkeys');
    return res.data.passkeys;
  }, []);
  const { data: passkeys, loading, error: loadError, reload } = useLoadable<Passkey[]>(loadPasskeys, [], 'Failed to load passkeys');

  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [pendingAdd, setPendingAdd] = useState<string | null>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const [pendingRemove, setPendingRemove] = useState<Passkey | null>(null);
  const [confirmedRemove, setConfirmedRemove] = useState<Passkey | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const handleAdd = () => {
    const trimmed = name.trim();
    if (!trimmed) { toast.error('Give the passkey a name so you can recognise it later'); return; }
    setPendingAdd(trimmed);
  };

  const executeAdd = async (stepUpToken: string) => {
    if (!pendingAdd) return;
    setAdding(true);
    try {
      await registerPasskey(pendingAdd, stepUpToken);
      setName('');
      toast.success('Passkey added');
      void reload();
    } catch (err) {
      // A dismissed browser prompt is a cancel; only a real failure is shown.
      const message = webauthnErrorMessage(err, 'Failed to add the passkey');
      if (message) toast.error(message);
    } finally {
      setAdding(false);
      setPendingAdd(null);
    }
  };

  const executeRename = async (passkey: Passkey) => {
    const trimmed = renameValue.trim();
    setRenamingId(null);
    if (!trimmed || trimmed === passkey.name) return;
    try {
      const res = await api.renamePasskey(passkey.id, trimmed);
      if (res.success) { toast.success('Passkey renamed'); void reload(); }
      else toast.error(res.message || 'Failed to rename the passkey');
    } catch (err) {
      toast.error(formatError(err, 'Failed to rename the passkey'));
    }
  };

  const executeRemove = async (passkey: Passkey, stepUpToken: string) => {
    setRemoving(passkey.id);
    try {
      const res = await api.deletePasskey(passkey.id, stepUpToken);
      if (res.success) { toast.success('Passkey removed'); void reload(); }
      else toast.error(res.message || 'Failed to remove the passkey');
    } catch (err) {
      // Includes the server's LAST_SIGN_IN_METHOD explanation, shown verbatim.
      toast.error(formatError(err, 'Failed to remove the passkey'));
    } finally {
      setRemoving(null);
      setConfirmedRemove(null);
    }
  };

  const columns: Column<Passkey>[] = [
    {
      id: 'name',
      header: 'Name',
      cellClassName: 'font-medium text-gray-900 dark:text-gray-100',
      render: (p) => (renamingId === p.id ? (
        <div className="flex items-center gap-1">
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void executeRename(p);
              if (e.key === 'Escape') setRenamingId(null);
            }}
            maxLength={64}
            aria-label="Passkey name"
            className="max-w-[200px]"
            autoFocus
          />
          <Button variant="ghost" size="xs" aria-label="Save name" onClick={() => void executeRename(p)}>
            <Check className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="xs" aria-label="Cancel rename" onClick={() => setRenamingId(null)}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span>{p.name}</span>
          {p.backedUp && (
            <span title="Synced through a password manager or keychain — available on your other devices.">
              <Badge color="green">synced</Badge>
            </span>
          )}
        </div>
      )),
    },
    { id: 'created', header: 'Added', render: (p) => <RelativeTime value={p.createdAt} /> },
    {
      id: 'lastUsed',
      header: 'Last used',
      render: (p) => (p.lastUsedAt ? <RelativeTime value={p.lastUsedAt} /> : <span className="text-gray-400">never</span>),
    },
    {
      id: 'actions',
      header: '',
      cellClassName: 'text-right',
      render: (p) => (renamingId === p.id ? null : (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="xs"
            readOnly={readOnly}
            onClick={() => { setRenamingId(p.id); setRenameValue(p.name); }}
            className="gap-1"
          >
            <Pencil className="w-3.5 h-3.5" /> Rename
          </Button>
          <Button
            variant="ghost"
            size="xs"
            readOnly={readOnly}
            disabled={removing === p.id}
            onClick={() => setPendingRemove(p)}
            className="gap-1 text-red-600 hover:text-red-700"
          >
            <Trash2 className="w-3.5 h-3.5" /> Remove
          </Button>
        </div>
      )),
    },
  ];

  // Nothing to offer on a browser without WebAuthn (and nothing rendered until
  // we know, so the section doesn't flash in and out during hydration).
  if (supported !== true) return null;

  return (
    <SectionCard
      icon={Fingerprint}
      title="Passkeys"
      description="Sign in and confirm sensitive actions with your device — a fingerprint, face or screen lock — instead of a password. A passkey never leaves your device and can't be phished."
    >
      <div className="flex flex-wrap items-end gap-2 mb-4">
        <FormField label="Name" className="flex-1 min-w-[180px]">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. MacBook Touch ID"
            maxLength={64}
            disabled={adding || readOnly}
          />
        </FormField>
        <Button onClick={handleAdd} loading={adding || !!pendingAdd} readOnly={readOnly}>Add passkey</Button>
      </div>

      {pendingAdd && (
        <StepUpModal
          action="Confirm your identity to add a passkey to this account."
          onConfirmed={executeAdd}
          onClose={() => setPendingAdd(null)}
        />
      )}

      {loading && passkeys.length === 0 ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
      ) : loadError && passkeys.length === 0 ? (
        <RetryError message={loadError} onRetry={() => void reload()} />
      ) : (
        <div className="overflow-x-auto">
          <DataTable
            data={passkeys}
            columns={columns}
            isLoading={false}
            animated={false}
            getRowKey={(p) => p.id}
            emptyState={{
              icon: Fingerprint,
              title: 'No passkeys yet',
              description: 'Add one above to sign in without a password.',
            }}
          />
        </div>
      )}

      {pendingRemove && (
        <ConfirmDialog
          title="Remove this passkey?"
          confirmLabel="Remove"
          tone="danger"
          loading={removing === pendingRemove.id}
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            setConfirmedRemove(pendingRemove);
            setPendingRemove(null);
          }}
        >
          <p>
            <strong className="text-gray-800 dark:text-gray-100">{pendingRemove.name}</strong> can no longer be used to
            sign in or to confirm sensitive actions. The credential on the device itself is not deleted — remove it there
            too if you no longer want it.
          </p>
        </ConfirmDialog>
      )}

      {confirmedRemove && (
        <StepUpModal
          action={`Confirm your identity to remove the passkey “${confirmedRemove.name}”.`}
          onConfirmed={(token) => executeRemove(confirmedRemove, token)}
          onClose={() => setConfirmedRemove(null)}
        />
      )}
    </SectionCard>
  );
}
