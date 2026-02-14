import { ExternalLink } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';

export default function GrafanaPage() {
  const { isReady, isSysAdmin } = useAuthGuard({ requireSystemAdmin: true });

  if (!isReady || !isSysAdmin) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Grafana"
      actions={
        <a
          href="/grafana/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
        >
          Open in new tab
          <ExternalLink className="w-4 h-4" />
        </a>
      }
      mainClassName="!px-0"
    >
      <iframe
        src="/grafana/"
        title="Grafana"
        className="w-full border-0"
        style={{ height: 'calc(100vh - 80px)' }}
        allow="fullscreen"
      />
    </DashboardLayout>
  );
}
