// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { AlertTriangle, HardDrive, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { RetryError } from '@/components/ui/RetryError';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { formatError } from '@/lib/constants';
import { formatBytes } from '@/lib/format';
import type { ReclaimCandidate, StorageReclaimPlan } from '@/types';

/** Why a version can't be retired, in the user's terms. */
const WHY: Record<string, string> = {
  in_use: 'A pipeline still uses this version',
  published: 'Published — unlist the listing to free these bytes',
  unknown_version: 'Not one of your plugin versions',
};

/**
 * What freeing this version would actually give back.
 *
 * Shows the MARGINAL figure, and shows the total only when the two differ —
 * which is the moment the distinction matters. A version sharing a base layer
 * occupies 411 MB and frees 11; printing one number would either promise space
 * that will not appear or hide why the image looks big.
 */
function Reclaimable({ c }: { c: ReclaimCandidate }) {
  const shared = c.totalBytes > c.marginalBytes;
  return (
    <span className="text-right tabular-nums">
      <span className={c.marginalBytes > 0 ? 'font-medium text-fg' : 'text-fg-muted'}>{c.marginalLabel}</span>
      {shared && (
        <span
          className="block text-xs text-fg-subtle"
          title={`This version's layers total ${formatBytes(c.totalBytes)}, but most are shared with other versions. Only the layers unique to this one come back.`}
        >
          of {formatBytes(c.totalBytes)} shared
        </span>
      )}
    </span>
  );
}

/**
 * The storage an organization can free, and the action that frees it.
 *
 * This exists because `storageBytes` was the only quota a tenant could not act
 * on: scheduled garbage collection is off by default, manual collection is
 * superadmin-only, and deleting a plugin version left its registry layers in
 * place. So an 80% storage notice could only ever be followed by "buy capacity
 * or contact support". Listing what is actually reclaimable — and letting an
 * admin reclaim it — is the other half of warning someone.
 *
 * Renders nothing when there is nothing to say (no candidates at all), so it
 * does not take up the page for an org with no plugin images.
 */
export function StorageReclaimCard() {
  // The gate lives WITH the control rather than being passed in: retiring a
  // version's image is plugin management, which `plugins:write` already covers
  // ("Create, upload, edit, and delete plugins"), and keeping the check here is
  // what lets the route-permission contract find it. A viewer without it still
  // SEES what is reclaimable — which is what lets them ask someone who can.
  const { can } = useAuthGuard();
  // TWO gates, because the card does two things. Reading the breakdown needs
  // `plugins:read` — without it the fetch would 403 and the card would show a
  // retry error to someone who simply may not look — and retiring a version
  // needs `plugins:write`. A reader without the write gate still SEES what is
  // reclaimable, which is what lets them ask someone who can.
  const canRead = can('plugins:read');
  const canManage = can('plugins:write');
  const [pruning, setPruning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data, loading, error: loadError, refetch } = useFetch<StorageReclaimPlan | null>(
    async (signal) => (await api.getStorageReclaim({ signal })).data ?? null,
    [canRead],
    { enabled: canRead },
  );

  if (!canRead || loading) return null;
  // A failed read is reported, never rendered as an empty list: "nothing to
  // free" is the opposite of "we could not look".
  if (loadError) {
    return (
      <Card>
        <h3 className="h3 mb-2">Storage you can free</h3>
        <RetryError message={formatError(loadError)} onRetry={refetch} />
      </Card>
    );
  }
  if (!data || data.candidates.length === 0) return null;

  const prune = async (c: ReclaimCandidate) => {
    const key = `${c.repo}:${c.tag}`;
    setPruning(key);
    setError(null);
    try {
      await api.pruneStorageVersion(c.repo, c.tag);
      await refetch();
    } catch (err) {
      // A 409 here is the server re-checking at the moment of deletion — a
      // pipeline may have started using the version since this list was read.
      setError(formatError(err));
    } finally {
      setPruning(null);
    }
  };

  return (
    <Card>
      <div className="flex items-start justify-between mb-1">
        <h3 className="h3 flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-fg-muted" aria-hidden />
          Storage you can free
        </h3>
        <span className="text-sm text-fg-muted tabular-nums">
          {data.reclaimableLabel} of {data.usedLabel}
        </span>
      </div>
      <p className="text-xs text-fg-muted mb-3">
        Storage counts each distinct image layer once, so retiring a version frees only the layers
        unique to it. The figures below are what each removal would actually recover.
      </p>

      {data.incomplete && (
        <p className="mb-3 flex items-start gap-1.5 rounded border border-warning-border bg-warning-bg p-2 text-xs text-warning-strong">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Some images could not be measured, so this list is incomplete and the figures are a lower
          bound. Try again shortly for the full picture.
        </p>
      )}

      {error && <p className="mb-3 text-sm text-danger-strong" role="alert">{error}</p>}

      <ul className="divide-y divide-default" aria-label="Reclaimable image versions">
        {data.candidates.map((c) => {
          const key = `${c.repo}:${c.tag}`;
          return (
            <li key={key} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-fg">
                  {c.pluginName ?? c.repo}
                  <span className="ml-1.5 font-mono text-xs text-fg-muted">{c.tag}</span>
                </p>
                {!c.eligible && (
                  <p className="mt-0.5 text-xs text-fg-muted">
                    {WHY[c.reason ?? 'unknown_version']}
                    {c.blockedBy.length > 0 && (
                      <span className="text-fg-subtle">
                        {': '}{c.blockedBy.map((p) => p.name ?? p.id).join(', ')}
                      </span>
                    )}
                  </p>
                )}
              </div>
              <Reclaimable c={c} />
              {c.eligible ? (
                canManage ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pruning !== null}
                    onClick={() => void prune(c)}
                    className="shrink-0 text-danger-strong"
                    aria-label={`Retire ${c.pluginName ?? c.repo} ${c.tag}`}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                    {pruning === key ? 'Retiring…' : 'Retire'}
                  </Button>
                ) : null
              ) : (
                // Shown rather than hidden, with the reason: "why can't I free
                // this?" is the question an org has when it is out of space.
                <span className="shrink-0"><Badge color="gray">Kept</Badge></span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
