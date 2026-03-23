import { useMemo } from 'react';
import { formatError } from '@/lib/constants';
import { Building2, AlertTriangle, Search } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { useDelete } from '@/hooks/useDelete';
import api from '@/lib/api';
import { Organization } from '@/types';

/** Organization management page (system admin only). Lists all organizations with delete capability. */
export default function OrganizationsPage() {
  const { user, isReady, isAuthenticated, isSysAdmin } = useAuthGuard({ requireSystemAdmin: true });

  const list = useListPage<Organization>({
    fields: [
      { key: 'search', type: 'text', defaultValue: '', primary: true },
    ],
    fetcher: async (params) => {
      const page = Math.floor(Number(params.offset || 0) / Number(params.limit || 25)) + 1;
      const response = await api.listOrganizations({
        ...(params.search && { search: params.search }),
        page,
        limit: Number(params.limit || 25),
      });
      const data = response.data;
      return {
        items: data?.organizations || [],
        pagination: data ? { total: data.total, offset: (data.page - 1) * data.limit } : undefined,
      };
    },
    enabled: isAuthenticated && isSysAdmin,
  });

  const del = useDelete<Organization>(
    async (org) => {
      await api.deleteOrganization(org.id);
    },
    list.refresh,
    (err) => list.setError(formatError(err, 'Failed to delete organization')),
  );

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
          <button onClick={() => del.open(org)} className="action-link-danger">Delete</button>
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
      subtitle="Manage organizations and access"
      titleExtra={<Badge color="red">System Admin</Badge>}
    >
      {list.error && (
        <div className="alert-error">
          <p>{list.error}</p>
          <button onClick={() => list.setError(null)} className="action-link-danger mt-2 underline">Dismiss</button>
        </div>
      )}

      <div className="filter-bar">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="Search organizations..."
            value={list.filters.search}
            onChange={(e) => list.updateFilter('search', e.target.value)}
            className="filter-input"
          />
        </div>
      </div>

      <DataTable
        data={list.data}
        columns={orgColumns}
        isLoading={list.isLoading}
        emptyState={{ icon: Building2, title: 'No organizations', description: 'No organizations found.' }}
        getRowKey={(org) => org.id}
        defaultSortColumn="name"
      />

      {!list.isLoading && list.pagination.total > 0 && (
        <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
      )}

      {/* Warning */}
      <div className="card mt-6 border-yellow-200/60 dark:border-yellow-800/60 bg-yellow-50/80 dark:bg-yellow-900/20">
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

      {del.target && (
        <DeleteConfirmModal
          title="Delete Organization"
          itemName={del.target.name}
          loading={del.loading}
          onConfirm={del.confirm}
          onCancel={del.close}
        />
      )}
    </DashboardLayout>
  );
}
