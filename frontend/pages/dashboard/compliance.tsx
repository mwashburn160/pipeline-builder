import dynamic from 'next/dynamic';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage } from '@/components/ui/Loading';

const ComplianceDashboard = dynamic(() => import('@/components/compliance/ComplianceDashboard'), {
  loading: () => <LoadingPage />,
});

export default function CompliancePage() {
  // Viewing requires only `compliance:read` (members hold it in their base
  // bundle), so read-only users can see rules, policies, and scans. Editing
  // affordances inside ComplianceDashboard are gated separately on
  // `compliance:write` via the `canManage` prop. Backend remains the real gate
  // (compliance APIs 403 regardless); this is the cosmetic layer.
  const { isReady, can } = useAuthGuard({ requirePermission: 'compliance:read' });

  if (!isReady) return <LoadingPage />;

  return (
    <DashboardLayout title="Compliance" subtitle="Organization compliance rules and policies">
      <ComplianceDashboard canManage={can('compliance:write')} />
    </DashboardLayout>
  );
}
