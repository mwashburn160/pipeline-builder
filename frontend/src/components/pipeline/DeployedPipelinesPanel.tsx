import { useEffect, useState } from 'react';
import { Cloud, ChevronDown, ChevronRight } from 'lucide-react';
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
 * Live drift detection (registered-but-no-stack, stack-but-no-row) is
 * intentionally NOT done here — the `pipeline-manager audit-stacks` CLI does
 * that scan against AWS CFN. This panel only shows the registry view; pair
 * with the CLI for full drift analysis.
 */
export function DeployedPipelinesPanel() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<RegistryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
              <li key={row.id} className="py-2 flex items-center justify-between text-sm">
                <div>
                  <div className="font-medium text-gray-900 dark:text-gray-100">{row.pipelineName}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {row.region && <span>{row.region}</span>}
                    {row.stackName && <span> · stack {row.stackName}</span>}
                  </div>
                </div>
                <div className="text-xs text-gray-400" title={new Date(row.lastDeployed).toLocaleString()}>
                  Deployed {formatRelativeTime(row.lastDeployed)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
