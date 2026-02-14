import { useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';

export default function LokiLoggingPage() {
  const { user, isReady, isSysAdmin } = useAuthGuard();

  const iframeSrc = useMemo(() => {
    const base = '/grafana/explore';
    const orgFilter = !isSysAdmin && user?.organizationId
      ? `{orgId="${user.organizationId}"}`
      : '{}';

    const params = new URLSearchParams({
      orgId: '1',
      left: JSON.stringify({
        datasource: 'loki',
        queries: [{ refId: 'A', expr: orgFilter }],
        range: { from: 'now-1h', to: 'now' },
      }),
    });

    return `${base}?${params.toString()}`;
  }, [isSysAdmin, user?.organizationId]);

  if (!isReady) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Loki Logging"
      actions={
        <a
          href={iframeSrc}
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
        src={iframeSrc}
        title="Loki Logging"
        className="w-full border-0"
        style={{ height: 'calc(100vh - 80px)' }}
        allow="fullscreen"
      />
    </DashboardLayout>
  );
}
