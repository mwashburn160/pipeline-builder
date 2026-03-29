import dynamic from 'next/dynamic';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage } from '@/components/ui/Loading';

const ComplianceDashboard = dynamic(() => import('@/components/compliance/ComplianceDashboard'), {
  loading: () => <LoadingPage />,
});

export default function CompliancePage() {
  const { isReady, isAdmin } = useAuthGuard();

  if (!isReady) return <LoadingPage />;

  if (!isAdmin) {
    return (
      <DashboardLayout title="Compliance" subtitle="Organization compliance rules and policies">
        <div className="page-section">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            You must be an organization admin to access compliance settings.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="Compliance" subtitle="Organization compliance rules and policies">
      <ComplianceDashboard isAdmin />
    </DashboardLayout>
  );
}
