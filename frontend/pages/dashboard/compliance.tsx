import dynamic from 'next/dynamic';
import Link from 'next/link';
import { History } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import api from '@/lib/api';
import type { ComplianceAuditEntry } from '@/types/compliance';

const ComplianceDashboard = dynamic(() => import('@/components/compliance/ComplianceDashboard'), {
  loading: () => <LoadingPage />,
});

/**
 * Inline change log on the compliance page. Surfaces the 5 most recent
 * entries from `/api/compliance/audit` so admins can answer "who
 * changed what" without leaving the page. The richer drill-down lives
 * inside ComplianceDashboard for full filtering / pagination.
 */
function RecentChangesStrip() {
  const { data, loading, error } = useFetch(
    async () => {
      const res = await api.getComplianceAuditLog({ limit: 5 });
      if (res.success && res.data) return res.data.entries;
      throw new Error(res.message || 'Failed to load recent changes');
    },
    [],
  );
  const entries: ComplianceAuditEntry[] = data ?? [];

  return (
    <div className="card mb-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
          <History className="w-4 h-4 text-gray-400" />
          Recent compliance activity
        </h2>
        <Link href="/dashboard/audit?action=compliance" className="action-link text-xs">
          Full audit log →
        </Link>
      </div>
      {loading && <LoadingSpinner size="sm" />}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error.message}</p>}
      {!loading && entries.length === 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400 py-2">
          No compliance activity recorded yet. Changes to rules, policies, and scan results appear here.
        </p>
      )}
      {!loading && entries.length > 0 && (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {entries.map((e) => (
            <li key={e.id} className="py-1.5 flex items-baseline justify-between gap-2 text-sm">
              <div className="min-w-0 flex items-baseline gap-2">
                <Badge
                  color={e.result === 'pass' ? 'green' : e.result === 'warn' ? 'yellow' : 'red'}
                >
                  {e.result}
                </Badge>
                <span className="text-gray-800 dark:text-gray-200 truncate">
                  <code className="text-xs">{e.action}</code>
                  {e.entityName && <span className="text-gray-500 dark:text-gray-400"> on {e.entityName}</span>}
                </span>
                {e.violations.length > 0 && (
                  <span className="text-xs text-red-500 dark:text-red-400">
                    ({e.violations.length} violation{e.violations.length === 1 ? '' : 's'})
                  </span>
                )}
              </div>
              <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                <RelativeTime value={e.createdAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function CompliancePage() {
  // requireAdmin redirects non-admins to /dashboard (consistent with Members /
  // Groups / Audit) rather than rendering an in-page "not allowed" message that
  // still revealed the feature. Backend remains the real gate (compliance APIs
  // 403 regardless); this is the cosmetic, defense-in-depth layer.
  const { isReady } = useAuthGuard({ requireAdmin: true });

  if (!isReady) return <LoadingPage />;

  return (
    <DashboardLayout title="Compliance" subtitle="Organization compliance rules and policies">
      <RecentChangesStrip />
      <ComplianceDashboard isAdmin />
    </DashboardLayout>
  );
}
