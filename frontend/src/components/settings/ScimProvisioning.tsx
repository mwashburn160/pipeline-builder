// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useState } from 'react';
import { RefreshCw, Users2 } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Callout } from '@/components/ui/Callout';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FormField } from '@/components/ui/FormField';
import { Badge } from '@/components/ui/Badge';
import { CopyButton } from '@/components/ui/CopyButton';
import { SecretReveal } from '@/components/ui/SecretReveal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { ReadOnlyNotice } from '@/components/ui/ReadOnlyNotice';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useFetch } from '@/hooks/useFetch';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { ServiceAccount } from '@/lib/api/domains/organizations';

/** The service account SCIM keys are issued against. One per org, created on
 *  demand, so an admin never has to know the service-account model exists to turn
 *  provisioning on — and every SCIM key stays in one obvious place. */
const SCIM_ACCOUNT_NAME = 'scim-provisioning';

/** The capability scope a SCIM key carries (api-core `TOKEN_SCOPES`). */
const SCIM_SCOPE = 'scim';

/** One SCIM key, flattened out of the account that owns it. */
interface ScimKey {
  id: string;
  accountId: string;
  name: string;
  display: string;
  status: 'active' | 'expired' | 'revoked';
  expiresAt: string;
  lastUsedAt: string | null;
}

/**
 * SCIM 2.0 provisioning (3b), on the org SSO settings page.
 *
 * Two things an admin needs to hand their identity provider: the base URL and a
 * bearer token. This produces exactly those — the URL is fixed, and "Issue a SCIM
 * key" mints a `scim`-scoped key on a dedicated service account (created on first
 * use). The raw key is shown once.
 *
 * What the copy states rather than implies, because these are the things people
 * get wrong about directory sync:
 *   - a SCIM key can provision and deactivate members and move them between
 *     groups, and NOTHING else — it carries no permissions, so it cannot read
 *     pipelines or decide what a group is worth;
 *   - which roles a directory group grants is decided HERE, in the group-mapping
 *     editor above, never by the directory;
 *   - users are provisioned only at verified email domains, and the org owner is
 *     never deactivated by a sync.
 *
 * Gated on `service_accounts:manage` by the page (issuing a key IS issuing a
 * machine credential); every write is step-up gated, like every other key mint.
 */
const NO_ACCOUNTS: ServiceAccount[] = [];

export function ScimProvisioning({ orgId, readOnly }: { orgId: string; readOnly: boolean }) {
  const toast = useToast();

  const load = useCallback(async (): Promise<ServiceAccount[]> => {
    const res = await api.listServiceAccounts(orgId);
    if (!res.success || !res.data) throw new Error('Failed to load SCIM credentials');
    return res.data.serviceAccounts;
  }, [orgId]);
  const { data: accountsLoaded, loading, error: errorFailure, refetch: reload } = useFetch<ServiceAccount[]>(() => load(), [load], {
    onError: (err) => toast.error(formatError(err, 'Failed to load SCIM credentials')),
  });
  const accounts = accountsLoaded ?? NO_ACCOUNTS;
  const error = errorFailure ? formatError(errorFailure, 'Failed to load SCIM credentials') : null;

  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [days, setDays] = useState(365);
  const [pendingIssue, setPendingIssue] = useState<'account' | 'key' | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ScimKey | null>(null);

  /** Every `scim`-scoped key in the org, whichever account holds it — an org that
   *  minted one by hand on another account still sees it here. */
  const scimKeys = useMemo<ScimKey[]>(
    () => accounts.flatMap((account) => account.keys
      .filter((k) => k.scope === SCIM_SCOPE)
      .map((k) => ({
        id: k.id,
        accountId: account.id,
        name: k.name,
        display: k.display,
        status: k.status,
        expiresAt: k.expiresAt,
        lastUsedAt: k.lastUsedAt,
      }))),
    [accounts],
  );

  // Rendered on the server too, where there is no `window`; the absolute URL is
  // only meaningful in the browser, so fall back to the relative path.
  const baseUrl = typeof window === 'undefined' ? '/api/scim/v2' : `${window.location.origin}/api/scim/v2`;

  /**
   * Issuing is TWO step-up-gated writes on first use — create the dedicated
   * service account, then mint its key — and a step-up token is single-use.
   * Spending one token on both made the key mint fail with STEP_UP_REPLAY right
   * after the account was created, so every first SCIM key failed. Each write
   * gets its own confirmation instead: `pendingIssue` walks 'account' → 'key'.
   */
  const scimAccount = accounts.find((a) => a.name === SCIM_ACCOUNT_NAME) ?? null;
  const [createdAccountId, setCreatedAccountId] = useState<string | null>(null);

  /** Step 1 (first use only): the account the key will belong to. */
  const createAccount = async (stepUpToken: string) => {
    setBusy(true);
    let nextStage: typeof pendingIssue = null;
    try {
      const created = await api.createServiceAccount(orgId, {
        name: SCIM_ACCOUNT_NAME,
        description: 'SCIM 2.0 provisioning from your identity provider',
        // No roles: a scoped key carries none anyway, and an unscoped key on a
        // role-less account can do nothing either.
        roleIds: [],
      }, stepUpToken);
      if (!created.success || !created.data) { toast.error('Failed to create the SCIM service account'); return; }
      setCreatedAccountId(created.data.serviceAccount.id);
      nextStage = 'key';
      void reload();
    } catch (err) {
      toast.error(formatError(err, 'Failed to create the SCIM service account'));
    } finally {
      setBusy(false);
      setPendingIssue(nextStage);
    }
  };

  /** Step 2: mint the key, with a confirmation of its own. */
  const issueKey = async (stepUpToken: string) => {
    const accountId = scimAccount?.id ?? createdAccountId;
    if (!accountId) { setPendingIssue('account'); return; }
    setBusy(true);
    setNewKey(null);
    try {
      const res = await api.createServiceAccountKey(orgId, accountId, {
        name: `scim-${new Date().toISOString().slice(0, 10)}`,
        expiresIn: Math.floor(days) * 86400,
        scope: SCIM_SCOPE,
      }, stepUpToken);
      if (res.success && res.data) {
        setNewKey(res.data.key);
        toast.success('SCIM key issued');
      } else {
        toast.error('Failed to issue the SCIM key');
      }
      await reload();
    } catch (err) {
      toast.error(formatError(err, 'Failed to issue the SCIM key'));
    } finally {
      setBusy(false);
      setPendingIssue(null);
    }
  };

  const revokeKey = async (key: ScimKey) => {
    setBusy(true);
    try {
      const res = await api.revokeServiceAccountKey(orgId, key.accountId, key.id);
      if (res.success) { toast.success('SCIM key revoked'); await reload(); }
      else {toast.error('Failed to revoke the key');}
    } catch (err) {
      toast.error(formatError(err, 'Failed to revoke the key'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      icon={Users2}
      title="SCIM provisioning"
      description="Let your identity provider create, update and deactivate members here automatically. Removing someone in your directory removes their access in Pipeline Builder."
    >
      <ReadOnlyNotice show={readOnly} />

      {/* Deliberately not a FormField: that clones its single child to carry the
          label's `htmlFor`, and this row is an input NEXT TO a copy button, so
          the association has to be made directly on the input. */}
      <div>
        <label htmlFor="scim-base-url" className="label">SCIM base URL</label>
        <div className="flex items-center gap-2">
          <Input id="scim-base-url" value={baseUrl} readOnly className="font-mono text-sm" />
          <CopyButton text={baseUrl} />
        </div>
        <p className="mt-1 text-xs text-fg-muted">
          Paste this into your identity provider&apos;s SCIM connector. It is the same for every organization —
          the key you issue below is what says which one.
        </p>
      </div>

      <Callout variant="neutral" className="my-4">
        A SCIM key can add, update and deactivate members of this organization and move them between directory
        groups — and nothing else. <strong>Which roles a group grants is decided above</strong>, in group-to-role
        mapping, never by your directory. Users can only be provisioned at email domains this organization has
        verified, and the organization owner is never deactivated by a sync.
      </Callout>

      {newKey && (
        <SecretReveal
          value={newKey}
          label="SCIM key — copy it now, it is never shown again"
          note="Paste it into your identity provider as the SCIM bearer token. It is stored here only as a hash."
          filename="pipeline-builder-scim-key.txt"
          onDone={() => setNewKey(null)}
          className="mb-4"
        />
      )}

      <div className="flex flex-wrap items-end gap-2 mb-4">
        <FormField label="Key lifetime (days)" className="w-40" hint="Maximum 365.">
          <Input
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            disabled={busy || readOnly}
          />
        </FormField>
        <Button
          onClick={() => {
            const d = Math.floor(days);
            if (!Number.isFinite(d) || d < 1 || d > 365) { toast.error('Key lifetime must be 1-365 days'); return; }
            setNewKey(null);
            setPendingIssue(scimAccount || createdAccountId ? 'key' : 'account');
          }}
          loading={busy && pendingIssue !== null}
          readOnly={readOnly}
          className="gap-1"
        >
          <RefreshCw className="w-4 h-4" /> Issue a SCIM key
        </Button>
      </div>

      {loading && scimKeys.length === 0 ? (
        <Skeleton className="h-12 rounded-lg" />
      ) : error && scimKeys.length === 0 ? (
        <RetryError message={error} onRetry={() => void reload()} />
      ) : scimKeys.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No SCIM keys yet. Issue one to connect your identity provider.
        </p>
      ) : (
        <div className="space-y-1">
          {scimKeys.map((key) => (
            <div key={key.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-default px-3 py-2 text-xs">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{key.display}</span>
                <span>{key.name}</span>
                <Badge color={key.status === 'active' ? 'green' : key.status === 'expired' ? 'gray' : 'red'}>{key.status}</Badge>
                <span className="text-fg-muted">expires <RelativeTime value={key.expiresAt} /></span>
                <span className="text-fg-muted">
                  {key.lastUsedAt ? <>last used <RelativeTime value={key.lastUsedAt} /></> : 'never used'}
                </span>
              </span>
              {key.status === 'active' && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-danger hover:text-danger-strong"
                  readOnly={readOnly}
                  disabled={busy}
                  onClick={() => setPendingRevoke(key)}
                >
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {pendingIssue === 'account' && (
        <StepUpModal
          key="account"
          title="Set up SCIM provisioning?"
          action="Create the SCIM provisioning service account"
          details={(
            <p>
              Step 1 of 2: a dedicated service account, with no roles, that the provisioning key will belong
              to. You confirm the key itself next.
            </p>
          )}
          onConfirmed={createAccount}
          // Only ever closes ITS stage: confirming moves on to 'key', and the
          // dialog's own close after a confirm must not undo that.
          onClose={() => setPendingIssue((cur) => (cur === 'account' ? null : cur))}
        />
      )}

      {pendingIssue === 'key' && (
        <StepUpModal
          key="key"
          title="Issue a SCIM provisioning key?"
          action="Issue a SCIM provisioning key"
          details={(
            <p>
              It lets your identity provider add, update and deactivate members of this organization —
              and nothing else. It is shown exactly once, on the next screen.
            </p>
          )}
          onConfirmed={issueKey}
          onClose={() => setPendingIssue((cur) => (cur === 'key' ? null : cur))}
        />
      )}

      {pendingRevoke && (
        <ConfirmDialog
          title="Revoke this SCIM key?"
          confirmLabel="Revoke key"
          tone="danger"
          loading={busy}
          onCancel={() => setPendingRevoke(null)}
          onConfirm={async () => {
            const key = pendingRevoke;
            setPendingRevoke(null);
            await revokeKey(key);
          }}
        >
          <p>
            Your identity provider stops being able to provision within five minutes, and its next sync will
            fail. Existing members keep their access — nothing is deactivated by revoking a key. Issue a
            replacement first if the sync must keep running.
          </p>
        </ConfirmDialog>
      )}
    </SectionCard>
  );
}
