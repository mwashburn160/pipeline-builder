import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';
import { Organization, isSystemAdmin } from '@/types';

export default function OrganizationsPage() {
  const router = useRouter();
  const { user, isAuthenticated, isInitialized, isLoading: authLoading } = useAuth();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Only system admins can access this page
  const isSysAdmin = isSystemAdmin(user);

  useEffect(() => {
    if (isInitialized && !authLoading && !isAuthenticated) {
      router.push('/auth/login');
    }
    // Redirect non-system admins
    if (isInitialized && !authLoading && isAuthenticated && !isSysAdmin) {
      router.push('/dashboard');
    }
  }, [isAuthenticated, isInitialized, authLoading, isSysAdmin, router]);

  useEffect(() => {
    async function fetchOrganizations() {
      if (!isAuthenticated || !isSysAdmin) return;
      
      try {
        setIsLoading(true);
        const response = await api.listOrganizations();
        // Handle response format
        const orgList = (response as any).organizations || response.data || [];
        setOrganizations(orgList);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load organizations');
      } finally {
        setIsLoading(false);
      }
    }

    if (isAuthenticated && isSysAdmin) {
      fetchOrganizations();
    }
  }, [isAuthenticated, isSysAdmin]);

  const handleDeleteOrg = async (orgId: string) => {
    setDeleteLoading(true);
    setError(null);

    try {
      await api.deleteOrganization(orgId);
      setOrganizations(organizations.filter(o => o.id !== orgId));
      setDeleteConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete organization');
    } finally {
      setDeleteLoading(false);
    }
  };

  if (!isInitialized || authLoading) {
    return <LoadingPage message="Loading..." />;
  }

  if (!isAuthenticated || !user || !isSysAdmin) {
    return <LoadingPage message="Redirecting..." />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div className="flex items-center space-x-4">
            <Link href="/dashboard" className="text-gray-500 hover:text-gray-700">
              ← Back
            </Link>
            <h1 className="text-2xl font-bold text-gray-900">Organizations</h1>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
              System Admin
            </span>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {error && (
          <div className="mb-6 rounded-md bg-red-50 p-4">
            <p className="text-sm font-medium text-red-800">{error}</p>
            <button 
              onClick={() => setError(null)}
              className="mt-2 text-sm text-red-600 underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-12">
            <LoadingSpinner size="lg" />
          </div>
        ) : organizations.length === 0 ? (
          <div className="bg-white shadow rounded-lg p-6 text-center">
            <svg
              className="mx-auto h-12 w-12 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
              />
            </svg>
            <h3 className="mt-4 text-lg font-medium text-gray-900">No organizations</h3>
            <p className="mt-2 text-sm text-gray-500">No organizations found.</p>
          </div>
        ) : (
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Organization
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Members
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {organizations.map((org) => (
                  <tr key={org.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div>
                          <div className="text-sm font-medium text-gray-900">
                            {org.name}
                            {org.id === 'system' && (
                              <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800">
                                System
                              </span>
                            )}
                          </div>
                          {org.description && (
                            <div className="text-sm text-gray-500 truncate max-w-xs">
                              {org.description}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {org.memberCount} member{org.memberCount !== 1 ? 's' : ''}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {org.createdAt ? new Date(org.createdAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      {org.id !== 'system' && (
                        <>
                          {deleteConfirm === org.id ? (
                            <div className="flex items-center justify-end space-x-2">
                              <span className="text-red-600 text-xs">Confirm?</span>
                              <button
                                onClick={() => handleDeleteOrg(org.id)}
                                disabled={deleteLoading}
                                className="text-red-600 hover:text-red-900 font-medium"
                              >
                                {deleteLoading ? 'Deleting...' : 'Yes'}
                              </button>
                              <button
                                onClick={() => setDeleteConfirm(null)}
                                disabled={deleteLoading}
                                className="text-gray-600 hover:text-gray-900"
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setDeleteConfirm(org.id)}
                              className="text-red-600 hover:text-red-900"
                            >
                              Delete
                            </button>
                          )}
                        </>
                      )}
                      {org.id === 'system' && (
                        <span className="text-gray-400 text-xs">Protected</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Warning */}
        <div className="mt-6 rounded-md bg-yellow-50 p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-yellow-800">Warning</h3>
              <p className="mt-1 text-sm text-yellow-700">
                Deleting an organization will remove all members from the organization. 
                This action cannot be undone. Users will not be deleted but will no longer belong to any organization.
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
