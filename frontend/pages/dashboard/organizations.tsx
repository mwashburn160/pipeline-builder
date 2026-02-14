import { useEffect, useState, useMemo } from 'react';
import { Building2, AlertTriangle } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import api from '@/lib/api';
import { Organization } from '@/types';

export default function OrganizationsPage() {
  const { user, isReady, isAuthenticated, isSysAdmin } = useAuthGuard({ requireSystemAdmin: true });
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Organization | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    async function fetchOrganizations() {
      if (!isAuthenticated || !isSysAdmin) return;
      try {
        setIsLoading(true);
        const response = await api.listOrganizations();
        const orgList = response.organizations || [];
        setOrganizations(orgList);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to load organizations');
      } finally {
        setIsLoading(false);
      }
    }

    if (isAuthenticated && isSysAdmin) fetchOrganizations();
  }, [isAuthenticated, isSysAdmin]);

  const handleDeleteOrg = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    setError(null);

    try {
      await api.deleteOrganization(deleteTarget.id);
      setOrganizations(organizations.filter(o => o.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to delete organization');
      setDeleteTarget(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const orgColumns: Column<Organization>[] = useMemo(() => [
    {
      id: 'name',
      header: 'Organization',
      sortValue: (org) => org.name,
      render: (org) => (
        <div>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {org.name}
            {org.id === 'system' && <> <Badge color="purple">System</Badge></>}
          </div>
          {org.description && (
            <div className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-xs">{org.description}</div>
          )}
        </div>
      ),
    },
    {
      id: 'members',
      header: 'Members',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (org) => org.memberCount,
      render: (org) => <>{org.memberCount} member{org.memberCount !== 1 ? 's' : ''}</>,
    },
    {
      id: 'created',
      header: 'Created',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (org) => org.createdAt ? new Date(org.createdAt) : null,
      render: (org) => <>{org.createdAt ? new Date(org.createdAt).toLocaleDateString() : '\u2014'}</>,
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right text-sm font-medium',
      render: (org) => (
        org.id !== 'system' ? (
          <button onClick={() => setDeleteTarget(org)} className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300 transition-colors">Delete</button>
        ) : (
          <span className="text-gray-400 dark:text-gray-500 text-xs">Protected</span>
        )
      ),
    },
  ], []);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Organizations"
      titleExtra={<Badge color="red">System Admin</Badge>}
    >
      {error && (
        <div className="alert-error">
          <p>{error}</p>
          <button onClick={() => setError(null)} className="mt-2 text-sm text-red-600 dark:text-red-400 underline">Dismiss</button>
        </div>
      )}

      <DataTable
        data={organizations}
        columns={orgColumns}
        isLoading={isLoading}
        emptyState={{ icon: Building2, title: 'No organizations', description: 'No organizations found.' }}
        getRowKey={(org) => org.id}
        defaultSortColumn="name"
      />

      {/* Warning */}
      <div className="mt-6 rounded-xl bg-yellow-50 dark:bg-yellow-900/20 p-4 border border-yellow-200/60 dark:border-yellow-800/60">
        <div className="flex">
          <AlertTriangle className="h-5 w-5 text-yellow-400 dark:text-yellow-500 flex-shrink-0" />
          <div className="ml-3">
            <h3 className="text-sm font-medium text-yellow-800 dark:text-yellow-300">Warning</h3>
            <p className="mt-1 text-sm text-yellow-700 dark:text-yellow-400">
              Deleting an organization will remove all members from the organization.
              This action cannot be undone. Users will not be deleted but will no longer belong to any organization.
            </p>
          </div>
        </div>
      </div>

      {deleteTarget && (
        <DeleteConfirmModal
          title="Delete Organization"
          itemName={deleteTarget.name}
          loading={deleteLoading}
          onConfirm={handleDeleteOrg}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </DashboardLayout>
  );
}
