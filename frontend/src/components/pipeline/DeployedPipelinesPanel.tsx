import { useCallback, useEffect, useState } from 'react';
import { Cloud, RefreshCw, X } from 'lucide-react';
import { Disclosure } from '@/components/ui/Disclosure';
import { Modal } from '@/components/ui/Modal';
import { ResourceList } from '@/components/ui/ResourceList';
import api from '@/lib/api';
import { formatRelativeTime } from '@/lib/relative-time';

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
 * `pipeline-manager audit-stacks` which surfaces these orphans across an org.
 */
export function DeployedPipelinesPanel() {
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

  const fetchRegistry = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPipelineRegistry({ limit: 50 });
      if (res.success && res.data) {
        setRows(res.data.registry);
        setLoaded(true);
      } else {
        setError('Failed to load registry');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load registry');
    } finally {
      setLoading(false);
    }
  }, []);

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
      } else {
        setError('Failed to remove registry entry');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove registry entry');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <>
      <Disclosure
        open={open}
        onToggle={setOpen}
        className="mb-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
        summaryClassName="cursor-pointer list-none px-4 py-3 flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg"
        bodyClassName="px-4 pb-4 pt-2 border-t border-gray-200 dark:border-gray-700"
        title={
          <>
            <Cloud className="w-4 h-4 text-blue-500" />
            <span>Deployed pipelines</span>
            {loaded && <span className="ml-2 text-xs text-gray-500">{rows.length}</span>}
            {open && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); fetchRegistry(); }}
                disabled={loading}
                title="Refresh"
                aria-label="Refresh deployed pipelines"
                className="ml-auto p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 disabled:opacity-50"
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
            description: 'Pipelines register here when `pipeline-manager deploy` succeeds.',
          }}
        >
          {rows.length > 0 && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {rows.map((row) => (
                <li key={`${row.id}:${row.pipelineId}`} className="py-2 flex items-center justify-between text-sm gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-900 dark:text-gray-100">{row.pipelineName}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {row.region && <span>{row.region}</span>}
                      {row.stackName && <span> · stack {row.stackName}</span>}
                    </div>
                  </div>
                  <div className="text-xs text-gray-400 shrink-0" title={new Date(row.lastDeployed).toLocaleString()}>
                    Deployed {formatRelativeTime(row.lastDeployed)}
                  </div>
                  <button
                    onClick={() => setConfirmTarget(row)}
                    disabled={removing === row.id}
                    className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-600 disabled:opacity-40 disabled:cursor-wait shrink-0"
                    title="Remove from registry (does not delete the AWS stack)"
                    aria-label={`Remove ${row.pipelineName} from registry`}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
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
            <p className="text-gray-700 dark:text-gray-300">
              Remove <strong className="font-mono">{confirmTarget.pipelineName}</strong> from the deployed-pipelines registry?
            </p>
            <div className="p-3 rounded border border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-900 dark:text-yellow-200 text-xs">
              This only removes the platform&apos;s record. It does NOT delete the CloudFormation stack or pipeline. Use this to reconcile drift when the AWS stack was already deleted out-of-band.
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmTarget(null)}
                disabled={!!removing}
                className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
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
