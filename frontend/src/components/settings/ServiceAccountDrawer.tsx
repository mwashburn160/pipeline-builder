// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { SideDrawer } from '@/components/ui/SideDrawer';
import { Badge } from '@/components/ui/Badge';
import { DescriptionList } from '@/components/ui/DescriptionList';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { AccessKeyTable, type KeyRow } from '@/components/settings/AccessKeyTable';
import { formatDateTime } from '@/lib/format';
import { permissionLabel } from '@pipeline-builder/api-core/permissions';
import type { ServiceAccount } from '@/lib/api/domains/organizations';

/**
 * One service account in full, read fresh from
 * `GET /organization/:id/service-accounts/:accountId` — its roles and the
 * effective permissions they add up to, the token budget and where this period
 * stands, and every key it holds (revocable from here through the owner's
 * confirm). The list card shows a summary; this is what an audit asks for.
 *
 * `version` changes whenever the owning list reloads (a revoke, an edit), so the
 * drawer never shows a stale account next to a fresh list.
 */
export function ServiceAccountDrawer({
  orgId,
  accountId,
  version,
  readOnly,
  revokingKeyId,
  onRevokeKey,
  onClose,
}: {
  orgId: string;
  accountId: string;
  version: unknown;
  readOnly: boolean;
  revokingKeyId: string | null;
  onRevokeKey: (account: ServiceAccount, key: KeyRow) => void;
  onClose: () => void;
}) {
  const { data: account, error, refetch } = useFetch(
    async (signal) => {
      const res = await api.getServiceAccount(orgId, accountId, { signal });
      if (!res.data?.serviceAccount) throw new Error('Service account not found');
      return res.data.serviceAccount;
    },
    [orgId, accountId, version],
  );

  return (
    <SideDrawer
      title={account?.name ?? 'Service account'}
      ariaLabel="Service account details"
      subtitle={account && (
        <>
          {account.disabled ? <Badge color="red">disabled</Badge> : <Badge color="green">active</Badge>}
          <span>no seat</span>
        </>
      )}
      onClose={onClose}
    >
      {error ? (
        <RetryError message={error.message || 'Failed to load the service account'} onRetry={refetch} />
      ) : !account ? (
        <LoadingSpinner />
      ) : (
        <div className="space-y-6">
          <DescriptionList
            items={[
              { label: 'Description', value: account.description || '—' },
              { label: 'Created', value: <>{formatDateTime(account.createdAt)} by {account.createdByEmail ?? 'unknown'}</> },
              { label: 'Last used', value: account.lastUsedAt ? <RelativeTime value={account.lastUsedAt} /> : 'Never' },
              {
                label: 'Token budget',
                value: account.tokenBudget === -1
                  ? `Unlimited (${account.usage.exchanges} exchanges this period)`
                  : `${account.usage.exchanges} / ${account.tokenBudget} exchanges this period`,
              },
              { label: 'Period resets', value: formatDateTime(account.usage.resetAt) },
              { label: 'Roles', value: account.roles.length > 0 ? account.roles.map((r) => r.name).join(', ') : 'None' },
            ]}
          />

          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--pb-text-muted)] mb-2">
              Effective permissions ({account.permissions.length})
            </p>
            {account.permissions.length === 0 ? (
              <p className="text-sm text-[var(--pb-text-muted)]">None — its keys can only carry a single capability scope.</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {account.permissions.map((p) => <Badge key={p} color="gray">{permissionLabel(p)}</Badge>)}
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--pb-text-muted)] mb-2">
              Keys ({account.keys.length})
            </p>
            <AccessKeyTable
              keys={account.keys}
              readOnly={readOnly}
              revokingId={revokingKeyId}
              showOwner={false}
              onRevoke={(key) => onRevokeKey(account, key)}
              emptyTitle="No keys yet"
              emptyDescription="Issue one with “New key” on the account's card."
            />
          </div>
        </div>
      )}
    </SideDrawer>
  );
}
