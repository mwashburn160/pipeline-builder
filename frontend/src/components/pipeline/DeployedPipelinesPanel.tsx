import { useEffect, useState } from 'react';
import { Cloud, ChevronDown, ChevronRight, X } from 'lucide-react';
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
  const [rows, setRows] = useState<RegistryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (!open || rows !== null) return;
    let cancelled = false;
    setLoading(true);
    api.listPipelineRegistry({ limit: 50 })
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) {
          setRows(res.data.registry);
        } else {
          setError('Failed to load registry');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load registry');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, rows]);

  const handleRemove = async (row: RegistryRow) => {
    const confirmed = window.confirm(
      `Remove "${row.pipelineName}" from the registry?\n\n` +
      `This only removes the platform's record. It does NOT delete the CloudFormation ` +
      `stack or pipeline. Use this to reconcile drift when the AWS stack was already ` +
      `deleted out-of-band.`,
    );
    if (!confirmed) return;
    setRemoving(row.id);
    setError(null);
    try {
      const res = await api.deletePipelineRegistry(row.id);
      if (res.success) {
        setRows((prev) => prev?.filter((r) => r.id !== row.id) ?? null);
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
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} className="mb-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
      <summary className="cursor-pointer list-none px-4 py-3 flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg">
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <Cloud className="w-4 h-4 text-blue-500" />
        Deployed pipelines
        {rows && <span className="ml-auto text-xs text-gray-500">{rows.length}</span>}
      </summary>
      <div className="px-4 pb-4 pt-2 border-t border-gray-200 dark:border-gray-700">
        {loading && <p className="text-sm text-gray-500">Loading registry…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!loading && !error && rows?.length === 0 && (
          <p className="text-sm text-gray-500">No deployed pipelines yet. Pipelines register here when <code>pipeline-manager deploy</code> succeeds.</p>
        )}
        {!loading && !error && rows && rows.length > 0 && (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {rows.map((row) => (
              <li key={row.id} className="py-2 flex items-center justify-between text-sm gap-2">
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
                  onClick={() => handleRemove(row)}
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
      </div>
    </details>
  );
}
