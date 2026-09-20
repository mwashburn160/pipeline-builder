// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AlertTriangle, Clock, KeyRound, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DataTable, type Column } from '@/components/ui/DataTable';
import type { AccessKeyMeta } from '@/lib/api/domains/auth';
import { describeCredentialAuthority } from '@/components/settings/token-scopes';

/** A key row with the service account that owns it (absent for a personal key). */
export interface KeyRow extends AccessKeyMeta {
  /** The account id a service-account key belongs to — the revoke handle. */
  ownerAccountId?: string;
}

const STATUS_COLOR: Record<AccessKeyMeta['status'], 'green' | 'gray' | 'red'> = {
  active: 'green',
  expired: 'gray',
  revoked: 'red',
};

interface AccessKeyTableProps {
  keys: KeyRow[];
  readOnly: boolean;
  /** Id of the key currently being revoked (its button shows as busy). */
  revokingId?: string | null;
  /** Ask to revoke. The caller owns the confirmation. */
  onRevoke: (key: KeyRow) => void;
  /** Disable every revoke control (e.g. another write is in flight). */
  disabled?: boolean;
  /**
   * Name the owning service account next to the key. On the access-keys list a
   * `pb_sa_…` row has no other context; inside a service account's own card the
   * owner is the heading above it, so it would only be noise.
   */
  showOwner?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
}

/**
 * The one rendering of a list of access keys — personal `pb_pat_…` and
 * service-account `pb_sa_…` alike, which are the same object with the same
 * lifecycle.
 *
 * It exists because they were rendered twice: a DataTable with status and
 * hygiene badges on the access-keys page, and a hand-rolled row of spans on the
 * service-accounts page that quietly omitted BOTH hygiene flags — so the keys
 * most likely to be stale (a machine key nobody has used, or one about to expire
 * at 3am) were exactly the ones whose warnings weren't shown.
 *
 * The two hygiene flags are surfaced inline because they are what an audit
 * actually asks: a key that has NEVER been used (mint-and-forget, pure risk) and
 * one EXPIRING SOON.
 */
export function AccessKeyTable({
  keys, readOnly, revokingId, onRevoke, disabled = false, showOwner = true,
  emptyTitle = 'No access keys yet',
  emptyDescription = 'Create a key above for the CLI, CI and integrations.',
}: AccessKeyTableProps) {
  const columns: Column<KeyRow>[] = [
    {
      id: 'name',
      header: 'Name',
      cellClassName: 'font-medium text-gray-900 dark:text-gray-100',
      render: (k) => (
        <div className="flex flex-col gap-0.5">
          <span>
            {k.name}
            {showOwner && k.kind === 'service_account' && (
              <span className="ml-1 text-xs text-fg-subtle">
                (service account{k.serviceAccountName ? `: ${k.serviceAccountName}` : ''})
              </span>
            )}
          </span>
          <span className="font-mono text-xs text-fg-subtle">{k.display}</span>
        </div>
      ),
    },
    {
      id: 'scope',
      header: 'Access',
      render: (k) => (
        <div className="flex flex-col gap-0.5 max-w-xs">
          {k.scope
            ? <span className="font-mono text-xs">{k.scope}</span>
            : k.kind === 'service_account'
              // A service account's authority is its Roles, shown on its own card.
              ? <span className="text-xs text-fg-subtle">the account&apos;s roles</span>
              : k.permissions
                ? (
                  <span className="text-xs" title={describeCredentialAuthority(k)}>
                    <Badge color="blue">{k.permissions.length} selected</Badge>{' '}
                    <span className="text-fg-muted">{describeCredentialAuthority(k)}</span>
                  </span>
                )
                : <span className="text-xs text-fg-subtle">full access (your current permissions)</span>}
          {/* An IP allowlist narrows a key as much as a scope does; it was only
              ever shown on the service-accounts page. */}
          {k.ipAllowlist && k.ipAllowlist.length > 0 && (
            <span className="text-xs text-fg-subtle">IPs: {k.ipAllowlist.join(', ')}</span>
          )}
        </div>
      ),
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
          {k.createdFrom && <span className="text-xs text-fg-subtle">{k.createdFrom}</span>}
        </div>
      ),
    },
    { id: 'expires', header: 'Expires', render: (k) => <RelativeTime value={k.expiresAt} /> },
    {
      id: 'lastUsed',
      header: 'Last used',
      render: (k) => (k.lastUsedAt ? <RelativeTime value={k.lastUsedAt} /> : <span className="text-fg-subtle">never</span>),
    },
    {
      id: 'actions',
      header: '',
      cellClassName: 'text-right',
      render: (k) => (!k.revoked && k.status !== 'expired' ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onRevoke(k)}
          readOnly={readOnly}
          disabled={disabled || revokingId === k.id}
          className="gap-1 text-danger hover:text-danger-strong"
        >
          <Trash2 className="w-3.5 h-3.5" /> Revoke
        </Button>
      ) : null),
    },
  ];

  return (
    <div className="overflow-x-auto">
      <DataTable
        data={keys}
        columns={columns}
        isLoading={false}
        animated={false}
        getRowKey={(k) => k.id}
        emptyState={{ icon: KeyRound, title: emptyTitle, description: emptyDescription }}
      />
    </div>
  );
}
