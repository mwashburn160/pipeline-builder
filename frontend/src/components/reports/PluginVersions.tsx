import { Puzzle, AlertTriangle } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Card } from '@/components/ui/Card';
import { SectionHeading, SectionCardSkeleton, ExportCSVButton } from './ReportHelpers';
import { MAX_VERSION_ROWS } from './constants';
import type { PluginVersion } from './types';

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
        <table className="w-full text-sm"><thead><tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700"><th className="pb-2 font-medium">Plugin</th><th className="pb-2 font-medium text-right">Versions</th><th className="pb-2 font-medium text-right">Latest</th><th className="pb-2 font-medium text-center">Default</th></tr></thead><tbody className="divide-y divide-gray-100 dark:divide-gray-800">{pluginVersions.slice(0, MAX_VERSION_ROWS).map((v) => (<tr key={v.name}><td className="py-1.5 text-gray-900 dark:text-gray-100">{v.name}</td><td className="py-1.5 text-right tabular-nums">{v.version_count}</td><td className="py-1.5 text-right font-mono text-xs">{v.latest_version}</td><td className="py-1.5 text-center">{v.has_default ? <span className="inline-block w-2 h-2 rounded-full bg-green-500" /> : <span className="inline-block w-2 h-2 rounded-full bg-amber-400" title="No default set" />}</td></tr>))}</tbody></table>
      </Card>
    </>
  );
}
