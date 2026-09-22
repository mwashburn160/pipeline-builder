// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState, type FormEvent } from 'react';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { ReservedName } from '@/types/ecosystem';
import { EcosystemActionDialog } from './EcosystemActionDialog';

interface Props {
  /** `useAuthGuard().can` — false for every ecosystem action during a read-only impersonation. */
  can: (permission: string) => boolean;
}

/** The server's shape rule for a reserved name (a lowercase handle or plugin name). */
export const RESERVED_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,254}$/;

/**
 * Ecosystem console → Reserved names (plan §3.0 "reserved names", §3.1): the
 * handles and listing names nobody may claim — a vendor's brand, a confusable.
 * A name reserved FOR a publisher is claimable by that publisher only; one
 * reserved for nobody refuses everyone, and a claim comes to the queue.
 * Adding and removing apply at once (audited as `ecosystem.reserved-name.update`).
 */
export function ReservedNamesPanel({ can }: Props) {
  const toast = useToast();
  const mayModerate = can('plugins:moderate');
  const namesQ = useFetch(async (signal) => {
    const res = await api.listReservedNames({ signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load reserved names');
    return res.data.names;
  }, []);
  const publishersQ = useFetch(async (signal) => {
    const res = await api.listEcosystemPublishers({}, { signal });
    return res.data?.publishers ?? [];
  }, []);
  const handleOf = useMemo(() => {
    const map = new Map((publishersQ.data ?? []).map((p) => [p.id, p.handle]));
    return (id: string) => map.get(id) ?? id;
  }, [publishersQ.data]);

  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [publisherId, setPublisherId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ReservedName | null>(null);

  const normalized = name.trim().toLowerCase();
  const invalid = normalized !== '' && !RESERVED_NAME_PATTERN.test(normalized);
  const names = namesQ.data ?? [];

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!normalized || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await api.putReservedName(normalized, { reason: reason.trim() || null, publisherId: publisherId || null });
      toast.success(`Reserved ${normalized}`);
      setName('');
      setReason('');
      setPublisherId('');
      namesQ.refetch();
    } catch (err) {
      setError(formatError(err, 'Failed to reserve the name'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    await api.deleteReservedName(removing.name);
    toast.success(`${removing.name} is no longer reserved`);
    namesQ.refetch();
  };

  return (
    <SectionCard
      icon={Lock}
      title="Reserved names"
      description="Handles and listing names nobody can claim. Reserve one for a publisher to let only that publisher claim it."
    >
      <div className="space-y-5">
        {mayModerate && (
          <form className="space-y-3 rounded-lg border border-default p-3" onSubmit={add} aria-label="Reserve a name">
            <div className="flex flex-wrap items-end gap-3">
              <FormField label="Name" className="min-w-[12rem]" required error={invalid ? 'Lowercase letters, digits, dot, dash or underscore' : undefined}>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. acme" disabled={busy} />
              </FormField>
              <FormField label="Reason (optional)" className="min-w-[14rem] flex-1">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Vendor brand" maxLength={500} disabled={busy} />
              </FormField>
              <FormField label="Reserved for" className="min-w-[12rem]">
                <Select value={publisherId} onChange={(e) => setPublisherId(e.target.value)} disabled={busy} aria-label="Reserved for publisher">
                  <option value="">Nobody (refuse everyone)</option>
                  {(publishersQ.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.handle}</option>)}
                </Select>
              </FormField>
              <Button type="submit" loading={busy} disabled={!normalized || invalid || busy}>
                <Plus className="w-4 h-4 mr-1" aria-hidden />Reserve
              </Button>
            </div>
            {error && <ErrorAlert message={error} />}
          </form>
        )}

        {namesQ.loading && !namesQ.data ? (
          <Skeleton className="h-24 w-full" />
        ) : namesQ.error ? (
          <RetryError message={formatError(namesQ.error, 'Failed to load reserved names')} onRetry={namesQ.refetch} />
        ) : names.length === 0 ? (
          <EmptyState compact icon={Lock} title="No reserved names" description="Only the built-in reserved words are held back." />
        ) : (
          <ul className="divide-y divide-default" aria-label="Reserved names">
            {names.map((n) => (
              <li key={n.name} className="flex flex-wrap items-center justify-between gap-3 py-2" data-testid={`reserved-${n.name}`}>
                <div className="min-w-0 space-y-0.5">
                  <div className="font-mono text-sm font-medium text-fg">{n.name}</div>
                  <p className="text-xs text-fg-muted">
                    {n.publisherId ? <>Reserved for <span className="font-mono">{handleOf(n.publisherId)}</span></> : 'Refused to everyone'}
                    {n.reason && <> · {n.reason}</>}
                    {' · added '}<RelativeTime value={n.createdAt} />
                  </p>
                </div>
                {mayModerate && (
                  <Button variant="secondary" size="xs" onClick={() => setRemoving(n)} aria-label={`Remove reserved name ${n.name}`}>
                    <Trash2 className="w-3.5 h-3.5 mr-1" aria-hidden />Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {removing && (
        <EcosystemActionDialog
          title={`Stop reserving ${removing.name}?`}
          action={`Remove the reservation of ${removing.name}`}
          details={<p>Anyone can then claim this name as a handle or listing name.</p>}
          stepUp={false}
          tone="danger"
          confirmLabel="Remove"
          onSubmit={remove}
          onClose={() => setRemoving(null)}
        />
      )}
    </SectionCard>
  );
}
