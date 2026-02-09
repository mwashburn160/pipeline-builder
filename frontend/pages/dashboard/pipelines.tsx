import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';
import { Pipeline, BuilderProps, isSystemAdmin, isOrgAdmin } from '@/types';
import CreatePipelineModal from '@/components/pipeline/CreatePipelineModal';

export default function PipelinesPage() {
  const router = useRouter();
  const { user, isAuthenticated, isInitialized, isLoading: authLoading } = useAuth();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accessFilter, setAccessFilter] = useState<'all' | 'public' | 'private'>('all');

  // Create pipeline modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);

  // Edit state
  const [showEditModal, setShowEditModal] = useState(false);
  const [editPipeline, setEditPipeline] = useState<Pipeline | null>(null);
  const [editPipelineName, setEditPipelineName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editKeywords, setEditKeywords] = useState('');
  const [editProps, setEditProps] = useState('');
  const [editIsActive, setEditIsActive] = useState(true);
  const [editIsDefault, setEditIsDefault] = useState(false);
  const [editAccessModifier, setEditAccessModifier] = useState<'public' | 'private'>('private');
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<Pipeline | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Determine user permissions
  const isSysAdmin = isSystemAdmin(user);
  const isOrgAdminUser = isOrgAdmin(user);
  const isAdmin = isSysAdmin || isOrgAdminUser;
  
  // Only system admins can view public pipelines
  // Org admins and regular users can only see private pipelines from their organization
  const canViewPublic = isSysAdmin;
  // Only system admins can create public pipelines
  const canCreatePublic = isSysAdmin;

  useEffect(() => {
    if (isInitialized && !authLoading && !isAuthenticated) {
      router.push('/auth/login');
    }
  }, [isAuthenticated, isInitialized, authLoading, router]);

  const fetchPipelines = async () => {
    if (!isAuthenticated) return;
    
    try {
      setIsLoading(true);
      const params: Record<string, string> = {};
      
      // Apply access filter
      if (accessFilter !== 'all') {
        params.accessModifier = accessFilter;
      } else if (!canViewPublic) {
        // Regular users can only see private pipelines
        params.accessModifier = 'private';
      }
      
      const response = await api.listPipelines(params);
      setPipelines((response.pipelines || []) as Pipeline[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pipelines');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      fetchPipelines();
    }
  }, [isAuthenticated, accessFilter, canViewPublic]);

  // Filter pipelines client-side as backup (in case API doesn't filter)
  const filteredPipelines = pipelines.filter(pipeline => {
    if (!canViewPublic && pipeline.accessModifier === 'public') {
      return false;
    }
    if (accessFilter !== 'all' && pipeline.accessModifier !== accessFilter) {
      return false;
    }
    return true;
  });

  const openCreateModal = () => {
    setShowCreateModal(true);
    setCreateError(null);
    setCreateSuccess(null);
  };

  const handleCreatePipeline = async (props: BuilderProps, accessModifier: 'public' | 'private') => {
    setCreateLoading(true);
    setCreateError(null);
    setCreateSuccess(null);

    try {
      const response = await api.createPipeline({
        props,
        accessModifier,
      });

      if (response.success) {
        setCreateSuccess('Pipeline created successfully!');
        await fetchPipelines();
        setTimeout(() => {
          setShowCreateModal(false);
          setCreateSuccess(null);
        }, 2000);
      }
    } catch (err) {
      let errorMessage = 'Failed to create pipeline';
      if (err instanceof Error) {
        errorMessage = err.message;
      }
      if (err && typeof err === 'object' && 'code' in err) {
        const apiErr = err as { message?: string; code?: string; statusCode?: number };
        errorMessage = apiErr.message || errorMessage;
        if (apiErr.code) {
          errorMessage += ` (${apiErr.code})`;
        }
      }
      setCreateError(errorMessage);
    } finally {
      setCreateLoading(false);
    }
  };

  const openEditModal = (pipeline: Pipeline) => {
    setEditPipeline(pipeline);
    setEditPipelineName(pipeline.pipelineName || '');
    setEditDescription(pipeline.description || '');
    setEditKeywords(pipeline.keywords?.join(', ') || '');
    setEditProps(JSON.stringify(pipeline.props || {}, null, 2));
    setEditIsActive(pipeline.isActive);
    setEditIsDefault(pipeline.isDefault);
    setEditAccessModifier(pipeline.accessModifier);
    setEditError(null);
    setEditSuccess(null);
    setShowEditModal(true);
  };

  const handleEditSave = async () => {
    if (!editPipeline) return;

    setEditLoading(true);
    setEditError(null);
    setEditSuccess(null);

    try {
      // Parse JSON fields
      let props: BuilderProps;
      
      try {
        props = editProps.trim() ? JSON.parse(editProps) : {};
      } catch {
        setEditError('Invalid JSON in props field');
        setEditLoading(false);
        return;
      }

      const response = await api.updatePipeline(editPipeline.id, {
        pipelineName: editPipelineName,
        description: editDescription,
        keywords: editKeywords.split(',').map(k => k.trim()).filter(k => k),
        props,
        isActive: editIsActive,
        isDefault: editIsDefault,
        accessModifier: editAccessModifier,
      });

      if (response.success) {
        setEditSuccess('Pipeline updated successfully!');
        await fetchPipelines();
        setTimeout(() => {
          setShowEditModal(false);
          setEditSuccess(null);
        }, 1500);
      }
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update pipeline');
    } finally {
      setEditLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;

    setDeleteLoading(true);
    try {
      const response = await api.deletePipeline(deleteTarget.id);
      if (response.success) {
        setDeleteTarget(null);
        await fetchPipelines();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete pipeline');
      setDeleteTarget(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const canDelete = (pipeline: Pipeline) => {
    if (isSysAdmin) return true;
    return pipeline.accessModifier === 'private';
  };

  if (!isInitialized || authLoading) {
    return <LoadingPage message="Loading..." />;
  }

  if (!isAuthenticated || !user) {
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
            <h1 className="text-2xl font-bold text-gray-900">Pipelines</h1>
          </div>
          
          <div className="flex items-center space-x-4">
            {/* Access Filter - Only show to system admins */}
            {canViewPublic && (
              <div className="flex items-center space-x-2">
                <label htmlFor="accessFilter" className="text-sm text-gray-600">
                  Filter:
                </label>
                <select
                  id="accessFilter"
                  value={accessFilter}
                  onChange={(e) => setAccessFilter(e.target.value as 'all' | 'public' | 'private')}
                  className="block w-32 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="all">All</option>
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                </select>
              </div>
            )}

            {/* Create Pipeline Button */}
            <button
              onClick={openCreateModal}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create Pipeline
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {/* Info banner for system admins */}
        {isSysAdmin && (
          <div className="mb-6 rounded-md bg-purple-50 p-4">
            <p className="text-sm text-purple-700">
              System Admin: Viewing all pipelines across all organizations.
            </p>
          </div>
        )}

        {/* Info banner for org admins */}
        {isOrgAdminUser && !isSysAdmin && (
          <div className="mb-6 rounded-md bg-blue-50 p-4">
            <p className="text-sm text-blue-700">
              Organization Admin: Viewing and managing pipelines for <strong>{user.organizationName || 'your organization'}</strong> only.
            </p>
          </div>
        )}

        {/* Info banner for regular users */}
        {!isAdmin && (
          <div className="mb-6 rounded-md bg-gray-50 p-4">
            <p className="text-sm text-gray-700">
              Viewing private pipelines for your organization.
            </p>
          </div>
        )}

        {error && (
          <div className="mb-6 rounded-md bg-red-50 p-4">
            <p className="text-sm font-medium text-red-800">{error}</p>
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-12">
            <LoadingSpinner size="lg" />
          </div>
        ) : filteredPipelines.length === 0 ? (
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
                d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
              />
            </svg>
            <h3 className="mt-4 text-lg font-medium text-gray-900">No pipelines yet</h3>
            <p className="mt-2 text-sm text-gray-500">
              {canViewPublic 
                ? 'Get started by creating your first pipeline.'
                : 'No private pipelines available for your organization.'}
            </p>
            <button
              onClick={openCreateModal}
              className="mt-4 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700"
            >
              Create Pipeline
            </button>
          </div>
        ) : (
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Name
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Project
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Organization
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Access
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredPipelines.map((pipeline) => (
                  <tr key={pipeline.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">
                        {pipeline.pipelineName}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {pipeline.project}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {pipeline.organization}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          pipeline.accessModifier === 'public'
                            ? 'bg-green-100 text-green-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {pipeline.accessModifier}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          pipeline.isActive
                            ? 'bg-green-100 text-green-800'
                            : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {pipeline.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <div className="flex items-center space-x-3">
                        {isSysAdmin || pipeline.accessModifier === 'private' ? (
                          <button
                            onClick={() => openEditModal(pipeline)}
                            className="text-blue-600 hover:text-blue-900 font-medium"
                          >
                            Edit
                          </button>
                        ) : (
                          <span className="text-gray-400 text-xs">Read-only</span>
                        )}
                        {canDelete(pipeline) && (
                          <button
                            onClick={() => setDeleteTarget(pipeline)}
                            className="text-red-600 hover:text-red-900 font-medium"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* Create Pipeline Modal */}
      <CreatePipelineModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreatePipeline}
        createLoading={createLoading}
        createError={createError}
        createSuccess={createSuccess}
        canCreatePublic={canCreatePublic}
      />

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => !deleteLoading && setDeleteTarget(null)} />
            <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
              <h3 className="text-lg font-medium text-gray-900 mb-2">Delete Pipeline</h3>
              <p className="text-sm text-gray-500 mb-1">
                Are you sure you want to delete <strong>{deleteTarget.pipelineName}</strong>?
              </p>
              <p className="text-sm text-red-600 mb-4">This action cannot be undone.</p>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setDeleteTarget(null)}
                  disabled={deleteLoading}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleteLoading}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700 disabled:opacity-50"
                >
                  {deleteLoading ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Pipeline Modal */}
      {showEditModal && editPipeline && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4 sticky top-0 bg-white pb-2">
              <h2 className="text-lg font-medium text-gray-900">Edit Pipeline</h2>
              <button
                onClick={() => setShowEditModal(false)}
                className="text-gray-400 hover:text-gray-500"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {editError && (
              <div className="mb-4 rounded-md bg-red-50 p-3">
                <p className="text-sm text-red-800">{editError}</p>
              </div>
            )}
            {editSuccess && (
              <div className="mb-4 rounded-md bg-green-50 p-3">
                <p className="text-sm text-green-800">{editSuccess}</p>
              </div>
            )}

            <div className="space-y-4">
              {/* Read-only Fields Section */}
              <div className="border-b pb-4">
                <h3 className="text-sm font-medium text-gray-500 mb-3">System Information (Read-only)</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">ID</label>
                    <p className="text-sm text-gray-700 font-mono bg-gray-50 px-2 py-1 rounded">{editPipeline.id}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Org ID</label>
                    <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{editPipeline.orgId}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Project</label>
                    <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{editPipeline.project}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Organization</label>
                    <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{editPipeline.organization}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Created By</label>
                    <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{editPipeline.createdBy}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Created At</label>
                    <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{new Date(editPipeline.createdAt).toLocaleString()}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Updated By</label>
                    <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{editPipeline.updatedBy}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Updated At</label>
                    <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{new Date(editPipeline.updatedAt).toLocaleString()}</p>
                  </div>
                </div>
              </div>

              {/* Editable Fields Section */}
              <div className="border-b pb-4">
                <h3 className="text-sm font-medium text-gray-500 mb-3">Core Information</h3>
                
                {/* Pipeline Name */}
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Pipeline Name</label>
                  <input
                    type="text"
                    value={editPipelineName}
                    onChange={(e) => setEditPipelineName(e.target.value)}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    disabled={editLoading}
                  />
                </div>

                {/* Description */}
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    rows={2}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    disabled={editLoading}
                  />
                </div>

                {/* Keywords */}
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Keywords (comma-separated)</label>
                  <input
                    type="text"
                    value={editKeywords}
                    onChange={(e) => setEditKeywords(e.target.value)}
                    placeholder="keyword1, keyword2, keyword3"
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    disabled={editLoading}
                  />
                </div>
              </div>

              {/* Pipeline Configuration */}
              <div className="border-b pb-4">
                <h3 className="text-sm font-medium text-gray-500 mb-3">Pipeline Configuration</h3>

                {/* Props (JSON) */}
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Props (JSON)</label>
                  <textarea
                    value={editProps}
                    onChange={(e) => setEditProps(e.target.value)}
                    rows={8}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono text-xs"
                    disabled={editLoading}
                    placeholder='{"project": "my-project", "organization": "my-org"}'
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Builder configuration including project, organization, and pipeline settings
                  </p>
                </div>
              </div>

              {/* Access & Status */}
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-3">Access & Status</h3>
                
                <div className="grid grid-cols-2 gap-4 mb-3">
                  {/* Access Modifier */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Access Modifier</label>
                    <select
                      value={editAccessModifier}
                      onChange={(e) => setEditAccessModifier(e.target.value as 'public' | 'private')}
                      className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm disabled:bg-gray-100 disabled:text-gray-500"
                      disabled={editLoading || !isSysAdmin}
                    >
                      <option value="private">Private</option>
                      <option value="public">Public</option>
                    </select>
                    {!isSysAdmin && (
                      <p className="text-xs text-gray-400 mt-1">Only system admins can change access level</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center space-x-6">
                  {/* Is Active */}
                  <div className="flex items-center">
                    <input
                      id="editPipelineIsActive"
                      type="checkbox"
                      checked={editIsActive}
                      onChange={(e) => setEditIsActive(e.target.checked)}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      disabled={editLoading}
                    />
                    <label htmlFor="editPipelineIsActive" className="ml-2 block text-sm text-gray-700">
                      Active
                    </label>
                  </div>

                  {/* Is Default */}
                  <div className="flex items-center">
                    <input
                      id="editPipelineIsDefault"
                      type="checkbox"
                      checked={editIsDefault}
                      onChange={(e) => setEditIsDefault(e.target.checked)}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      disabled={editLoading}
                    />
                    <label htmlFor="editPipelineIsDefault" className="ml-2 block text-sm text-gray-700">
                      Default
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end space-x-3 sticky bottom-0 bg-white pt-4">
              <button
                onClick={() => setShowEditModal(false)}
                disabled={editLoading}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Cancel
              </button>
              <button
                onClick={handleEditSave}
                disabled={editLoading}
                className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editLoading ? (
                  <>
                    <LoadingSpinner size="sm" className="mr-2" />
                    Saving...
                  </>
                ) : (
                  'Save Changes'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}