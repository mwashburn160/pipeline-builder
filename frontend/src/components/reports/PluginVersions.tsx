import { Puzzle, AlertTriangle } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { SectionHeading, SectionCardSkeleton, ExportCSVButton } from './ReportHelpers';
import { MAX_VERSION_ROWS } from './constants';
import type { PluginVersion } from './types';

const VERSION_COLUMNS: Column<PluginVersion>[] = [
  { id: 'name', header: 'Plugin', cellClassName: 'text-gray-900 dark:text-gray-100', render: (v) => v.name },
  { id: 'versions', header: 'Versions', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (v) => v.version_count },
  { id: 'latest', header: 'Latest', headerClassName: 'text-right', cellClassName: 'text-right font-mono text-xs', render: (v) => v.latest_version },
  {
    id: 'default',
    header: 'Default',
    headerClassName: 'text-center',
    cellClassName: 'text-center',
    render: (v) => (v.has_default
      ? <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
      : <span className="inline-block w-2 h-2 rounded-full bg-amber-400" title="No default set" />),
  },
];

interface PluginVersionsProps {
  loading: boolean;
  pluginVersions: PluginVersion[];
}

/** Plugins → Versions tab: stale-default warning + per-plugin version table. */
export function PluginVersions({ loading, pluginVersions }: PluginVersionsProps) {
  const hasVersionsData = pluginVersions.length > 0;
  const stalePlugins = pluginVersions.filter(v => !v.has_default);

  if (loading && !hasVersionsData) return <SectionCardSkeleton lines={6} />;
  if (!loading && !hasVersionsData) return <EmptyState icon={Puzzle} title="No version data yet" description="Create plugins to see version tracking and freshness warnings." illustration="plugins" />;
  if (!hasVersionsData) return null;

  return (
    <>
      {stalePlugins.length > 0 && (
        <Card className="border-amber-200/60 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-900/10">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-medium text-amber-800 dark:text-amber-300">{stalePlugins.length} plugin{stalePlugins.length !== 1 ? 's' : ''} without a default version</h3>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">{stalePlugins.map(p => p.name).join(', ')}</p>
            </div>
          </div>
        </Card>
      )}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <SectionHeading>Plugin Versions</SectionHeading>
          <ExportCSVButton data={pluginVersions.map(v => ({ name: v.name, versions: v.version_count, latest: v.latest_version, has_default: v.has_default }))} filename="plugin-versions" />
        </div>
        <DataTable
          data={pluginVersions.slice(0, MAX_VERSION_ROWS)}
          columns={VERSION_COLUMNS}
          isLoading={false}
          animated={false}
          getRowKey={(v) => v.name}
          emptyState={{ icon: Puzzle, title: 'No versions', description: 'No plugin version data yet.' }}
        />
      </Card>
    </>
  );
}
