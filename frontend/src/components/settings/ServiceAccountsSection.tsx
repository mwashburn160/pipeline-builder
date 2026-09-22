// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState, type ReactNode } from 'react';
import { Bot, Eye, KeyRound, Pencil, Power, Trash2 } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Callout } from '@/components/ui/Callout';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { SecretReveal } from '@/components/ui/SecretReveal';
import { RetryError } from '@/components/ui/RetryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { AccessKeyTable } from '@/components/settings/AccessKeyTable';
import { ServiceAccountDrawer } from '@/components/settings/ServiceAccountDrawer';
import { CreateServiceAccountForm } from '@/components/settings/CreateServiceAccountForm';
import { ServiceAccountDetails } from '@/components/settings/ServiceAccountDetails';
import { ServiceAccountKeys } from '@/components/settings/ServiceAccountKeys';
import type { ServiceAccountAction } from '@/components/settings/service-account-actions';
import { useFetch } from '@/hooks/useFetch';
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

/** Same members, order-insensitive — a reordered role list is not an edit. */
function sameRoleSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/**
 * Org service accounts: the page where an admin creates non-human
 * principals, gives them roles, and issues or revokes their `pb_sa_…` keys.
 *
 * Three properties the UI states rather than implies, because they are what
 * people get wrong about machine identities:
 *   - a service account takes NO seat and has its own token-exchange budget;
 *   - a key is shown exactly ONCE (only its hash is stored);
 *   - its roles can never exceed the permissions of whoever creates them —
 *     the backend refuses, and the picker only offers the org's roles.
 *
 * CONFIRMATION RULE, applied here as everywhere: one dialog per decision.
 *   - Creating an account, issuing a key, enabling/disabling and deleting are
 *     step-up gated server-side, so a single StepUpModal states the consequence
 *     AND takes the factor.
 *   - ROLE EDITS ARE A BATCH. Edits collect into a draft and Save sends the
 *     whole set once — one re-verification and one write, never a half-applied
 *     set.
 *   - Revoking a key is a plain confirm: the server deliberately does not gate
 *     revocation, so a compromised key is always killable.
 *
 * Every field the update API takes has a control: roles (above), enable/disable,
 * and — through Edit — the description and the token budget (also settable at
 * create; empty = unlimited). Details opens {@link ServiceAccountDrawer}, a
 * fresh read of the one account with its effective permissions and keys.
 *
 * Its keys are rendered by the shared {@link AccessKeyTable}, the same rows the
 * personal access-keys panel shows — including the never-used / expiring-soon
 * flags.
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
  const { data: dataLoaded, loading, error: loadErrorFailure, refetch: reload } = useFetch<ServiceAccountsData>(() => load(), [load], {
    onError: (err) => toast.error(formatError(err, 'Failed to load service accounts')),
  });
  const data = dataLoaded ?? EMPTY;
  const loadError = loadErrorFailure ? formatError(loadErrorFailure, 'Failed to load service accounts') : null;

  // Bumped after a create lands: remounting the form clears it.
  const [createFormKey, setCreateFormKey] = useState(0);
  // The account whose description/budget editor or new-key form is open. The
  // `open` counter remounts (and so re-seeds) the form on every open.
  const [detailsEditor, setDetailsEditor] = useState<{ accountId: string; open: number } | null>(null);
  const [keyForm, setKeyForm] = useState<{ accountId: string; open: number } | null>(null);
  // The account open in the detail drawer.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [pending, setPending] = useState<ServiceAccountAction | null>(null);
  const [pendingKeyRevoke, setPendingKeyRevoke] = useState<{ account: ServiceAccount; keyId: string; keyName: string } | null>(null);
  // Unsaved role edits, per account. Absent = the account's stored set.
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string[]>>({});
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);

  /** The role set currently shown for an account: its draft, else what it holds. */
  const rolesOf = (account: ServiceAccount): string[] =>
    roleDrafts[account.id] ?? account.roles.map((r) => r.id);

  const toggleAccountRole = (account: ServiceAccount, roleId: string) => {
    setRoleDrafts((prev) => {
      const current = prev[account.id] ?? account.roles.map((r) => r.id);
      const next = current.includes(roleId) ? current.filter((r) => r !== roleId) : [...current, roleId];
      return { ...prev, [account.id]: next };
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
          tokenBudget: pending.tokenBudget,
        }, stepUpToken);
        if (res.success) {
          toast.success('Service account created');
          setCreateFormKey((k) => k + 1);
        } else {toast.error('Failed to create service account');}
      } else if (pending.kind === 'details') {
        const res = await api.updateServiceAccount(orgId, pending.accountId, pending.changes, stepUpToken);
        if (res.success) {
          toast.success('Service account updated');
          setDetailsEditor(null);
        } else {toast.error('Failed to update service account');}
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
          setKeyForm(null);
          toast.success(`Key created for ${pending.accountName}`);
        } else {toast.error('Failed to create key');}
      } else if (pending.kind === 'toggle') {
        const res = await api.updateServiceAccount(orgId, pending.accountId, { disabled: pending.disabled }, stepUpToken);
        if (res.success) toast.success(pending.disabled ? 'Service account disabled' : 'Service account enabled');
        else toast.error('Failed to update service account');
      } else if (pending.kind === 'roles') {
        const res = await api.updateServiceAccount(orgId, pending.accountId, { roleIds: pending.roleIds }, stepUpToken);
        if (res.success) {
          toast.success('Roles updated');
          // The saved set is the stored set; drop the draft so the Save
          // button goes away instead of offering to re-send what just landed.
          setRoleDrafts((prev) => {
            const next = { ...prev };
            delete next[pending.accountId];
            return next;
          });
        } else {toast.error('Failed to update roles');}
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
    setRevokingKeyId(keyId);
    setBusy(true);
    try {
      const res = await api.revokeServiceAccountKey(orgId, account.id, keyId);
      if (res.success) { toast.success('Key revoked'); await reload(); }
      else {toast.error('Failed to revoke key');}
    } catch (err) {
      toast.error(formatError(err, 'Failed to revoke key'));
    } finally {
      setBusy(false);
      setRevokingKeyId(null);
    }
  };

  const keyFormAccount = keyForm ? data.accounts.find((a) => a.id === keyForm.accountId) : undefined;

  /** Heading + consequence for whichever step-up-gated action is held. */
  const stepUpCopy = (action: ServiceAccountAction): { title: string; action: string; details: ReactNode } => {
    switch (action.kind) {
      case 'create':
        return {
          title: 'Create this service account?',
          action: `Create the service account “${action.name}”`,
          details: (
            <p>
              It takes no seat, holds the roles you ticked, and can be given keys that act with them.{' '}
              {action.tokenBudget === -1
                ? 'Its keys may exchange for tokens without limit.'
                : `Its keys may exchange for at most ${action.tokenBudget} tokens per period.`}
            </p>
          ),
        };
      case 'details': {
        const { description: nextDescription, tokenBudget } = action.changes;
        return {
          title: 'Update this service account?',
          action: `Update ${action.accountName}`,
          details: (
            <ul className="list-disc pl-5 space-y-1">
              {nextDescription !== undefined && (
                <li>Description: {nextDescription ? `“${nextDescription}”` : 'cleared'}</li>
              )}
              {tokenBudget !== undefined && (
                <li>
                  Token budget: {tokenBudget === -1 ? 'unlimited' : `${tokenBudget} exchanges per period`}. A lower
                  budget can refuse its keys&apos; next exchanges this period.
                </li>
              )}
            </ul>
          ),
        };
      }
      case 'key':
        return {
          title: 'Issue a key?',
          action: `Issue the key “${action.name}” for ${action.accountName}`,
          details: (
            <p>
              The key is shown exactly once, on the next screen.{' '}
              {action.scope
                ? `It carries only ${action.scope} — none of the account's roles.`
                : 'It acts with the account’s full roles.'}
            </p>
          ),
        };
      case 'toggle':
        return {
          title: action.disabled ? 'Disable this service account?' : 'Enable this service account?',
          action: `${action.disabled ? 'Disable' : 'Enable'} ${action.accountName}`,
          details: action.disabled
            ? <p>Every key it holds stops authenticating within five minutes. Nothing is deleted — enabling it again restores access.</p>
            : <p>Its keys start authenticating again within five minutes.</p>,
        };
      case 'roles':
        return {
          title: 'Change this account’s roles?',
          action: `Set the roles of ${action.accountName}`,
          details: (
            <p>
              It will hold{' '}
              <strong className="text-fg">
                {action.roleNames.length > 0 ? action.roleNames.join(', ') : 'no roles at all'}
              </strong>
              . Every key it holds acts with that set from then on — except keys issued with a single capability.
            </p>
          ),
        };
      default:
        return {
          title: 'Delete this service account?',
          action: `Delete ${action.name}`,
          details: (
            <p>
              <strong className="text-fg">{action.name}</strong> and all{' '}
              {action.keyCount} of its keys are deleted. Anything authenticating as it stops working
              within five minutes.
            </p>
          ),
        };
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

      <CreateServiceAccountForm
        key={createFormKey}
        roles={data.roles}
        busy={busy}
        creating={busy && pending?.kind === 'create'}
        readOnly={readOnly}
        onRequest={setPending}
      />

      {newKey && (
        <SecretReveal
          value={newKey}
          label="Service-account key — copy it now, it is never shown again"
          filename="pipeline-builder-service-account-key.txt"
          onDone={() => setNewKey(null)}
          className="mb-4"
        />
      )}

      {loading && data.accounts.length === 0 ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
      ) : loadError && data.accounts.length === 0 ? (
        <RetryError message={loadError} onRetry={() => void reload()} />
      ) : data.accounts.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No service accounts yet"
          description="Create one above to give CI, automation or an integration its own identity — with its own roles and keys, and no seat."
        />
      ) : (
        <div className="space-y-3">
          {data.accounts.map((account) => {
            const draft = rolesOf(account);
            const stored = account.roles.map((r) => r.id);
            const rolesDirty = !sameRoleSet(draft, stored);
            return (
              <div key={account.id} className="rounded-lg border border-default p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-sm">
                      {account.name}
                      {account.disabled && <Badge color="red" className="ml-2">disabled</Badge>}
                    </span>
                    <span className="text-xs text-fg-muted">
                      {account.description || 'No description'} · created by {account.createdByEmail ?? 'unknown'}
                      {account.lastUsedAt ? <> · last used <RelativeTime value={account.lastUsedAt} /></> : ' · never used'}
                    </span>
                    <span className="text-xs text-fg-muted">
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
                      onClick={() => setViewingId(account.id)}
                    >
                      <Eye className="w-3.5 h-3.5" /> Details
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="gap-1"
                      readOnly={readOnly}
                      disabled={busy}
                      onClick={() => setDetailsEditor((prev) => ({ accountId: account.id, open: (prev?.open ?? 0) + 1 }))}
                    >
                      <Pencil className="w-3.5 h-3.5" /> Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="gap-1"
                      readOnly={readOnly}
                      disabled={busy}
                      onClick={() => setPending({
                        kind: 'toggle', accountId: account.id, accountName: account.name, disabled: !account.disabled,
                      })}
                    >
                      <Power className="w-3.5 h-3.5" /> {account.disabled ? 'Enable' : 'Disable'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="gap-1"
                      readOnly={readOnly}
                      disabled={busy}
                      onClick={() => setKeyForm((prev) => ({ accountId: account.id, open: (prev?.open ?? 0) + 1 }))}
                    >
                      <KeyRound className="w-3.5 h-3.5" /> New key
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="gap-1 text-danger hover:text-danger-strong"
                      readOnly={readOnly}
                      disabled={busy}
                      onClick={() => setPending({
                        kind: 'delete', accountId: account.id, name: account.name, keyCount: account.keys.length,
                      })}
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </Button>
                  </div>
                </div>

                {detailsEditor?.accountId === account.id && (
                  <ServiceAccountDetails
                    key={detailsEditor.open}
                    account={account}
                    saving={busy && pending?.kind === 'details'}
                    readOnly={readOnly}
                    onCancel={() => setDetailsEditor(null)}
                    onRequest={setPending}
                  />
                )}

                {/* Roles — the account's authority, edited as a SET and saved once. */}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {data.roles.map((role) => (
                    <label key={role.id} className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                      <input
                        type="checkbox"
                        checked={draft.includes(role.id)}
                        disabled={busy || readOnly}
                        aria-label={`${role.name} for ${account.name}`}
                        onChange={() => toggleAccountRole(account, role.id)}
                      />
                      {role.name}
                    </label>
                  ))}
                  {rolesDirty && (
                    <span className="ml-auto inline-flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={busy}
                        onClick={() => setRoleDrafts((prev) => {
                          const next = { ...prev };
                          delete next[account.id];
                          return next;
                        })}
                      >
                        Discard
                      </Button>
                      <Button
                        size="xs"
                        readOnly={readOnly}
                        disabled={busy}
                        onClick={() => setPending({
                          kind: 'roles',
                          accountId: account.id,
                          accountName: account.name,
                          roleIds: draft,
                          roleNames: data.roles.filter((r) => draft.includes(r.id)).map((r) => r.name),
                        })}
                      >
                        Save roles
                      </Button>
                    </span>
                  )}
                </div>

                {/* Keys — the same rows, and the same hygiene flags, as the
                    personal access-keys list. */}
                <div className="mt-3">
                  <AccessKeyTable
                    keys={account.keys}
                    readOnly={readOnly}
                    revokingId={revokingKeyId}
                    disabled={busy}
                    showOwner={false}
                    onRevoke={(key) => setPendingKeyRevoke({ account, keyId: key.id, keyName: key.name })}
                    emptyTitle="No keys yet"
                    emptyDescription="Issue one with “New key” — it is what this account authenticates with."
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* New-key form (per account) */}
      {keyFormAccount && keyForm && (
        <ServiceAccountKeys
          key={keyForm.open}
          account={keyFormAccount}
          issuing={busy && pending?.kind === 'key'}
          readOnly={readOnly}
          onCancel={() => setKeyForm(null)}
          onRequest={setPending}
        />
      )}

      {viewingId && (
        <ServiceAccountDrawer
          orgId={orgId}
          accountId={viewingId}
          version={data}
          readOnly={readOnly}
          revokingKeyId={revokingKeyId}
          onRevokeKey={(account, key) => setPendingKeyRevoke({ account, keyId: key.id, keyName: key.name })}
          onClose={() => setViewingId(null)}
        />
      )}

      {pending && (
        <StepUpModal
          {...stepUpCopy(pending)}
          onConfirmed={execute}
          onClose={() => setPending(null)}
        />
      )}

      {/* Revocation is NOT step-up gated server-side (see the module note), so
          this stays a plain confirm — one dialog, like everything else here. */}
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
            <strong className="text-fg">{pendingKeyRevoke.keyName}</strong> stops working
            within five minutes. Issue a replacement key first if the automation must keep running.
          </p>
        </ConfirmDialog>
      )}
    </SectionCard>
  );
}
