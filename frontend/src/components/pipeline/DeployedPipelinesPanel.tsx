import { useCallback, useEffect, useState } from 'react';
import { Cloud, RefreshCw, X } from 'lucide-react';
import { Disclosure } from '@/components/ui/Disclosure';
import { Modal } from '@/components/ui/Modal';
import { ResourceList } from '@/components/ui/ResourceList';
import api from '@/lib/api';
import { formatRelativeTime } from '@/lib/relative-time';
import { formatDateTime } from '@/lib/format';
import { formatError } from '@/lib/constants';

/** Registry rows fetched per page. */
const REGISTRY_PAGE = 50;

interface RegistryRow {
  id: string;
  pipelineId: string;
  pipelineName: string;
  region?: string;
  stackName?: string;
  lastDeployed: string;
}

/**
 * Lists pipelines that have actually been deployed (i.e. registered an ARN
 * via `POST /api/pipelines/registry` from CDK at deploy time). Distinct from
 * the main pipelines list which shows pipeline *configurations* — this panel
 * shows which configs have a live CloudFormation stack backing them.
 *
 * Each row exposes a Remove control for reconciling drift: if a CloudFormation
 * stack was deleted out-of-band (`aws cloudformation delete-stack`, console
 * action, etc.), the registry row stays behind. Removing it here calls
 * `DELETE /api/pipelines/registry/:id` to clear it. The CLI counterpart is
 * `pipeline-manager audit stacks` which surfaces these orphans across an org.
 */
export function DeployedPipelinesPanel({ canWrite = false }: { canWrite?: boolean }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<RegistryRow[]>([]);
  // Tracks "have we fetched once?" — distinct from rows so that an empty
  // list is still treated as loaded and we don't refetch on every reopen.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  // The remove modal needs more nuance than DeleteConfirmModal provides —
  // the action removes only the platform's record (not the AWS stack), and
  // that distinction is the whole point of the confirm.
  const [confirmTarget, setConfirmTarget] = useState<RegistryRow | null>(null);
  // The server's total, so the badge and the list cover every deployment,
  // not just the first page.
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchRegistry = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPipelineRegistry({ limit: REGISTRY_PAGE, offset: 0 });
      if (res.success && res.data) {
        setRows(res.data.registry);
        setTotal(res.data.pagination?.total ?? res.data.registry.length);
        setLoaded(true);
      } else {
        setError('Failed to load registry');
      }
    } catch (err) {
      setError(formatError(err, 'Failed to load registry'));
    } finally {
      setLoading(false);
    }
  }, []);

  /** Append the next page. */
  const loadMore = async () => {
    setLoadingMore(true);
    setError(null);
    try {
      const res = await api.listPipelineRegistry({ limit: REGISTRY_PAGE, offset: rows.length });
      if (res.success && res.data) {
        const seen = new Set(rows.map((r) => r.id));
        setRows((prev) => [...prev, ...res.data!.registry.filter((r) => !seen.has(r.id))]);
        setTotal(res.data.pagination?.total ?? total);
      } else {
        setError('Failed to load more of the registry');
      }
    } catch (err) {
      setError(formatError(err, 'Failed to load more of the registry'));
    } finally {
      setLoadingMore(false);
    }
  };

  // Load once when the panel first opens — single code path via fetchRegistry
  // (was a duplicated inline fetch that could drift from the callback).
  useEffect(() => {
    if (open && !loaded) void fetchRegistry();
  }, [open, loaded, fetchRegistry]);

  const performRemove = async (row: RegistryRow) => {
    setRemoving(row.id);
    setError(null);
    setConfirmTarget(null);
    try {
      const res = await api.deletePipelineRegistry(row.id);
      if (res.success) {
        setRows((prev) => prev.filter((r) => r.id !== row.id));
        setTotal((t) => Math.max(0, t - 1));
      } else {
        setError('Failed to remove registry entry');
      }
    } catch (err) {
      setError(formatError(err, 'Failed to remove registry entry'));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <>
      <Disclosure
        open={open}
        onToggle={setOpen}
        className="mb-4 rounded-lg border border-default bg-surface"
        summaryClassName="cursor-pointer list-none px-4 py-3 flex items-center gap-2 text-sm font-medium text-fg hover:bg-surface-muted rounded-lg"
        bodyClassName="px-4 pb-4 pt-2 border-t border-default"
        title={
          <>
            <Cloud className="w-4 h-4 text-brand" />
            <span>Deployed pipelines</span>
            {loaded && <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-2xs font-semibold rounded-full bg-surface-muted text-fg-muted">{total}</span>}
            {/* Always-visible purpose hint so the collapsed panel isn't a mystery. */}
            <span className="ml-2 text-xs font-normal text-fg-subtle hidden sm:inline">pipelines registered to a live deploy target</span>
            {open && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); void fetchRegistry(); }}
                disabled={loading}
                title="Refresh"
                aria-label="Refresh deployed pipelines"
                className="ml-auto p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-fg-muted disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            )}
          </>
        }
      >
        {/* Body migrated to <ResourceList> — owns skeleton/empty/error/refresh
            so this panel can stay focused on the registry-specific row layout
            and remove-confirm flow. Refresh button + count live in the
            Disclosure summary above; we hide ResourceList's header entirely
            (no filter, no refresh) to preserve the existing UX. */}
        <ResourceList<RegistryRow>
          variant="inline"
          loading={loading}
          error={error}
          onRefresh={fetchRegistry}
          hideRefresh
          isEmpty={rows.length === 0}
          skeletonLines={3}
          errorTitle="Failed to load registry"
          emptyState={{
            icon: Cloud,
            title: 'No deployed pipelines yet',
            description: 'Pipelines register here when `pipeline-manager pipeline deploy` succeeds.',
          }}
        >
          {rows.length > 0 && (
            <ul className="divide-y divide-default">
              {rows.map((row) => (
                <li key={`${row.id}:${row.pipelineId}`} className="py-2 flex items-center justify-between text-sm gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-fg">{row.pipelineName}</div>
                    <div className="text-xs text-fg-muted mt-0.5">
                      {row.region && <span>{row.region}</span>}
                      {row.stackName && <span> · stack {row.stackName}</span>}
                    </div>
                  </div>
                  <div className="text-xs text-fg-subtle shrink-0" title={formatDateTime(row.lastDeployed)}>
                    Deployed {formatRelativeTime(row.lastDeployed)}
                  </div>
                  {canWrite && (
                    <button
                      onClick={() => setConfirmTarget(row)}
                      disabled={removing === row.id}
                      className="p-1 rounded hover:bg-danger-bg text-fg-subtle hover:text-danger disabled:opacity-40 disabled:cursor-wait shrink-0"
                      title="Remove from registry (does not delete the AWS stack)"
                      aria-label={`Remove ${row.pipelineName} from registry`}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {rows.length > 0 && rows.length < total && (
            <div className="pt-2 flex items-center justify-between text-xs text-fg-muted">
              <span>Showing {rows.length} of {total}</span>
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="action-link disabled:opacity-50"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </ResourceList>
      </Disclosure>
      {confirmTarget && (
        <Modal
          title="Remove from registry"
          onClose={() => removing ? undefined : setConfirmTarget(null)}
          maxWidth="max-w-md"
        >
          <div className="space-y-3 text-sm">
            <p className="text-fg-muted">
              Remove <strong className="font-mono">{confirmTarget.pipelineName}</strong> from the deployed-pipelines registry?
            </p>
            <div className="p-3 rounded border border-warning-border bg-warning-bg text-warning-strong text-xs">
              This only removes the platform&apos;s record. It does NOT delete the CloudFormation stack or pipeline. Use this to reconcile drift when the AWS stack was already deleted out-of-band.
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmTarget(null)}
                disabled={!!removing}
                className="px-4 py-1.5 text-sm border border-default rounded-md text-fg-muted hover:bg-surface-muted"
              >
                Cancel
              </button>
              <button
                onClick={() => performRemove(confirmTarget)}
                disabled={!!removing}
                className="px-4 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
              >
                {removing === confirmTarget.id ? 'Removing…' : 'Remove record'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
