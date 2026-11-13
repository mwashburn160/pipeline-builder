// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { History } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { previousDefault } from '@/lib/toolchain-console';
import type { ToolchainDefaultHistoryEntry, ToolchainDefaultKind } from '@/types/toolchain';
import { SetPlatformDefaultFlow } from './SetPlatformDefaultFlow';

const KIND_LABEL: Record<ToolchainDefaultKind, string> = { set: 'Set', initial: 'Initial', restore: 'Restored (yank)' };

const COLUMNS: Column<ToolchainDefaultHistoryEntry>[] = [
  { id: 'release', header: 'Default', cellClassName: 'font-mono', render: (h) => h.releaseVersion },
  { id: 'previous', header: 'Previous', cellClassName: 'font-mono text-fg-muted', render: (h) => h.previousReleaseVersion ?? '—' },
  { id: 'kind', header: 'Kind', render: (h) => <Badge color={h.kind === 'restore' ? 'yellow' : 'gray'}>{KIND_LABEL[h.kind] ?? h.kind}</Badge> },
  { id: 'by', header: 'By', cellClassName: 'text-xs', render: (h) => h.setBy },
  { id: 'at', header: 'When', render: (h) => <RelativeTime value={h.setAt} /> },
  { id: 'reason', header: 'Reason', cellClassName: 'max-w-xs text-xs', render: (h) => h.reason ?? <span className="text-fg-subtle">—</span> },
];

/**
 * History (§11): every platform-default change (`set` / `initial` /
 * `restore`), newest first, and the normal rollback — "Set previous as
 * default", an ordinary promotion through the §8 guards whose canary gate is
 * waived because the release has already been default.
 */
export function ToolchainHistoryPanel({ platformDefault, canWrite, onChanged }: {
  platformDefault: string | null;
  canWrite: boolean;
  onChanged: () => Promise<unknown> | void;
}) {
  const [rollback, setRollback] = useState<string | null>(null);
  const read = useFetch(async (signal) => (await api.getToolchainDefaultHistory({ signal })).data?.history ?? null, [platformDefault]);
  const history = read.data;
  if (!history) {
    return read.error
      ? <RetryError message={formatError(read.error, 'Could not load the history')} onRetry={read.refetch} />
      : <div className="flex items-center gap-2 py-4 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading…</div>;
  }
  const previous = previousDefault(history, platformDefault);

  return (
    <div className="space-y-3" data-testid="toolchain-history">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">
          Current default: <span className="font-mono text-fg">{platformDefault ?? 'none'}</span>
          {previous && <> · previous: <span className="font-mono text-fg">{previous}</span></>}
        </p>
        <Button type="button" variant="secondary" readOnly={!canWrite} disabled={!previous} onClick={() => setRollback(previous)}>
          Set previous as default
        </Button>
      </div>
      <DataTable
        data={history}
        columns={COLUMNS}
        isLoading={false}
        animated={false}
        getRowKey={(h, i) => `${h.setAt}-${i}`}
        emptyState={{ icon: History, title: 'No default yet', description: 'The initial default is set by init-platform.sh on a fresh install.' }}
      />
      {rollback && (
        <SetPlatformDefaultFlow
          releaseVersion={rollback}
          action={`Set the previous release, ${rollback}, as the platform default`}
          onDone={() => { void onChanged(); }}
          onClose={() => setRollback(null)}
        />
      )}
    </div>
  );
}
