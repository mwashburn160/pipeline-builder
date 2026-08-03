import { Puzzle } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Card } from '@/components/ui/Card';
import { SectionHeading, StatCardSkeleton } from './ReportHelpers';
import { StatCard } from './StatCard';
import type { PluginSummary, PluginDistribution } from './types';

interface PluginOverviewProps {
  loading: boolean;
  pluginSummary: PluginSummary | null;
  distribution: PluginDistribution[];
}

/** Plugins → Overview tab: inventory summary + type/compute distribution bars. */
export function PluginOverview({ loading, pluginSummary, distribution }: PluginOverviewProps) {
  const hasPluginOverview = pluginSummary !== null;
  const typeDistribution = distribution.reduce<Record<string, number>>((acc, d) => { acc[d.plugin_type] = (acc[d.plugin_type] || 0) + d.count; return acc; }, {});
  const computeDistribution = distribution.reduce<Record<string, number>>((acc, d) => { acc[d.compute_type] = (acc[d.compute_type] || 0) + d.count; return acc; }, {});
  const maxDistCount = Math.max(1, ...Object.values(typeDistribution), ...Object.values(computeDistribution));

  if (loading && !hasPluginOverview) return <StatCardSkeleton count={5} />;
  if (!loading && !hasPluginOverview) return <EmptyState icon={Puzzle} title="No plugin data yet" description="Create and build plugins to see inventory stats and distribution here." illustration="plugins" />;
  if (!hasPluginOverview || !pluginSummary) return null;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        {[
          { label: 'Total', value: pluginSummary.total },
          { label: 'Active', value: pluginSummary.active },
          { label: 'Inactive', value: pluginSummary.inactive },
          { label: 'Public', value: pluginSummary.public },
          { label: 'Private', value: pluginSummary.private },
        ].map((s) => (
          <StatCard key={s.label} label={s.label} value={s.value} />
        ))}
      </div>
      {Object.keys(typeDistribution).length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <SectionHeading>By Plugin Type</SectionHeading>
            <div className="space-y-2">{Object.entries(typeDistribution).sort((a, b) => b[1] - a[1]).map(([type, count]) => (<div key={type} className="flex items-center gap-3"><span className="text-sm text-gray-700 dark:text-gray-300 w-36 truncate">{type}</span><div className="flex-1 h-5 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden"><div className="h-full bg-blue-500/70 rounded" style={{ width: `${(count / maxDistCount) * 100}%` }} /></div><span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums w-8 text-right">{count}</span></div>))}</div>
          </Card>
          <Card>
            <SectionHeading>By Compute Type</SectionHeading>
            <div className="space-y-2">{Object.entries(computeDistribution).sort((a, b) => b[1] - a[1]).map(([type, count]) => (<div key={type} className="flex items-center gap-3"><span className="text-sm text-gray-700 dark:text-gray-300 w-36 truncate">{type}</span><div className="flex-1 h-5 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden"><div className="h-full bg-purple-500/70 rounded" style={{ width: `${(count / maxDistCount) * 100}%` }} /></div><span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums w-8 text-right">{count}</span></div>))}</div>
          </Card>
        </div>
      )}
    </>
  );
}
