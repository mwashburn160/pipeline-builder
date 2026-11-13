// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { ToolchainCleanupCandidate } from '@/types/toolchain';

/**
 * Cleanup (§11): releases no deployed manifest, pin or org default references,
 * older than the last K defaults. Delete steps up; the server re-checks that
 * nothing references the release (in-use protection) and refuses otherwise.
 */
export function ToolchainCleanupPanel({ canWrite, onChanged }: { canWrite: boolean; onChanged: () => Promise<unknown> | void }) {
  const toast = useToast();
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useFetch(async (signal) => (await api.getToolchainCleanup({ signal })).data?.candidates ?? null, []);
  const candidates = read.data;
  if (!candidates) {
    return read.error
      ? <RetryError message={formatError(read.error, 'Could not load cleanup candidates')} onRetry={read.refetch} />
      : <div className="flex items-center gap-2 py-4 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading…</div>;
  }

  const remove = async (v: string, token: string) => {
    setError(null);
    try {
      await api.deleteToolchainRelease(v, token);
      toast.success(`Release ${v} deleted`);
      await read.refetch();
      await onChanged();
    } catch (err) {
      setError(formatError(err, `Could not delete ${v}`));
    } finally {
      setTarget(null);
    }
  };

  const columns: Column<ToolchainCleanupCandidate>[] = [
    { id: 'release', header: 'Release', cellClassName: 'font-mono', render: (c) => c.releaseVersion },
    { id: 'created', header: 'Created', render: (c) => <RelativeTime value={c.createdAt} /> },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      locked: true,
      render: (c) => (
        <Button type="button" size="xs" variant="danger-outline" readOnly={!canWrite} aria-label={`Delete ${c.releaseVersion}`} onClick={() => setTarget(c.releaseVersion)}>
          Delete
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-3" data-testid="toolchain-cleanup">
      {error && <ErrorAlert message={error} />}
      <DataTable
        data={candidates}
        columns={columns}
        isLoading={false}
        animated={false}
        getRowKey={(c) => c.releaseVersion}
        emptyState={{ icon: Sparkles, title: 'Nothing to clean up', description: 'Every older release is still referenced, or within the last 5 defaults.' }}
      />
      {target && (
        <StepUpModal
          title={`Delete ${target}?`}
          action={`Delete toolchain release ${target}`}
          details={<p className="text-sm">Both halves are deleted. Nothing references this release now; if something does by the time you confirm, the delete is refused.</p>}
          onConfirmed={(token) => remove(target, token)}
          onClose={() => setTarget(null)}
        />
      )}
    </div>
  );
}
