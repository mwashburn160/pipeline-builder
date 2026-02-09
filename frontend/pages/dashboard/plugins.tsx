import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';
import { Plugin, isSystemAdmin, isOrgAdmin } from '@/types';

export default function PluginsPage() {
  const router = useRouter();
  const { user, isAuthenticated, isInitialized, isLoading: authLoading } = useAuth();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accessFilter, setAccessFilter] = useState<'all' | 'public' | 'private'>('all');

  // Upload state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadAccess, setUploadAccess] = useState<'public' | 'private'>('private');
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Edit state
  const [showEditModal, setShowEditModal] = useState(false);
  const [editPlugin, setEditPlugin] = useState<Plugin | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editKeywords, setEditKeywords] = useState('');
  const [editVersion, setEditVersion] = useState('');
  const [editMetadata, setEditMetadata] = useState('');
  const [editPluginType, setEditPluginType] = useState('');
  const [editComputeType, setEditComputeType] = useState('');
  const [editEnv, setEditEnv] = useState('');
  const [editInstallCommands, setEditInstallCommands] = useState('');
  const [editCommands, setEditCommands] = useState('');
  const [editIsActive, setEditIsActive] = useState(true);
  const [editIsDefault, setEditIsDefault] = useState(false);
  const [editAccessModifier, setEditAccessModifier] = useState<'public' | 'private'>('private');
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<Plugin | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Determine user permissions
  const isSysAdmin = isSystemAdmin(user);
  const isOrgAdminUser = isOrgAdmin(user);
  const isAdmin = isSysAdmin || isOrgAdminUser;
  
  // Only system admins can view public plugins
  // Org admins and regular users can only see private plugins from their organization
  const canViewPublic = isSysAdmin;
  // Only system admins can upload public plugins
  const canUploadPublic = isSysAdmin;

  useEffect(() => {
    if (isInitialized && !authLoading && !isAuthenticated) {
      router.push('/auth/login');
    }
  }, [isAuthenticated, isInitialized, authLoading, router]);

  const fetchPlugins = async () => {
    if (!isAuthenticated) return;
    
    try {
      setIsLoading(true);
      const params: Record<string, string> = {};
      
      // Apply access filter
      if (accessFilter !== 'all') {
        params.accessModifier = accessFilter;
      } else if (!canViewPublic) {
        // Regular users can only see private plugins
        params.accessModifier = 'private';
      }
      
      const response = await api.listPlugins(params);
      setPlugins((response.plugins || []) as Plugin[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load plugins');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      fetchPlugins();
    }
  }, [isAuthenticated, accessFilter, canViewPublic]);

  // Filter plugins client-side as backup (in case API doesn't filter)
  const filteredPlugins = plugins.filter(plugin => {
    if (!canViewPublic && plugin.accessModifier === 'public') {
      return false;
    }
    if (accessFilter !== 'all' && plugin.accessModifier !== accessFilter) {
      return false;
    }
    return true;
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Validate file type (zip or tar.gz)
      const validTypes = ['application/zip', 'application/x-zip-compressed', 'application/gzip', 'application/x-gzip'];
      const validExtensions = ['.zip', '.tar.gz', '.tgz'];
      const hasValidExtension = validExtensions.some(ext => file.name.toLowerCase().endsWith(ext));
      
      if (!validTypes.includes(file.type) && !hasValidExtension) {
        setUploadError('Please select a .zip or .tar.gz file');
        return;
      }
      
      setUploadFile(file);
      setUploadError(null);
    }
  };

  const handleUpload = async () => {
    if (!uploadFile) {
      setUploadError('Please select a file to upload');
      return;
    }

    setUploadLoading(true);
    setUploadError(null);
    setUploadSuccess(null);

    try {
      const response = await api.uploadPlugin(uploadFile, uploadAccess);
      
      if (response.success) {
        setUploadSuccess('Plugin uploaded successfully!');
        setUploadFile(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        
        // Refresh plugin list
        await fetchPlugins();
        
        // Close modal after delay
        setTimeout(() => {
          setShowUploadModal(false);
          setUploadSuccess(null);
        }, 2000);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to upload plugin');
    } finally {
      setUploadLoading(false);
    }
  };

  const openUploadModal = () => {
    setShowUploadModal(true);
    setUploadFile(null);
    setUploadAccess('private');
    setUploadError(null);
    setUploadSuccess(null);
  };

  const openEditModal = (plugin: Plugin) => {
    setEditPlugin(plugin);
    setEditName(plugin.name);
    setEditDescription(plugin.description || '');
    setEditKeywords(plugin.keywords?.join(', ') || '');
    setEditVersion(plugin.version);
    setEditMetadata(JSON.stringify(plugin.metadata || {}, null, 2));
    setEditPluginType(plugin.pluginType);
    setEditComputeType(plugin.computeType);
    setEditEnv(JSON.stringify(plugin.env || {}, null, 2));
    setEditInstallCommands(plugin.installCommands?.join('\n') || '');
    setEditCommands(plugin.commands?.join('\n') || '');
    setEditIsActive(plugin.isActive);
    setEditIsDefault(plugin.isDefault);
    setEditAccessModifier(plugin.accessModifier);
    setEditError(null);
    setEditSuccess(null);
    setShowEditModal(true);
  };

  const handleEditSave = async () => {
    if (!editPlugin) return;

    setEditLoading(true);
    setEditError(null);
    setEditSuccess(null);

    try {
      // Parse JSON fields
      let metadata: Record<string, string | number | boolean> = {};
      let env: Record<string, string> = {};
      
      try {
        metadata = editMetadata.trim() ? JSON.parse(editMetadata) : {};
      } catch {
        setEditError('Invalid JSON in metadata field');
        setEditLoading(false);
        return;
      }
      
      try {
        env = editEnv.trim() ? JSON.parse(editEnv) : {};
      } catch {
        setEditError('Invalid JSON in env field');
        setEditLoading(false);
        return;
      }

      const response = await api.updatePlugin(editPlugin.id, {
        name: editName,
        description: editDescription,
        keywords: editKeywords.split(',').map(k => k.trim()).filter(k => k),
        version: editVersion,
        metadata,
        pluginType: editPluginType,
        computeType: editComputeType,
        env,
        installCommands: editInstallCommands.split('\n').filter(c => c.trim()),
        commands: editCommands.split('\n').filter(c => c.trim()),
        isActive: editIsActive,
        isDefault: editIsDefault,
        accessModifier: editAccessModifier,
      });

      if (response.success) {
        setEditSuccess('Plugin updated successfully!');
        await fetchPlugins();
        setTimeout(() => {
          setShowEditModal(false);
          setEditSuccess(null);
        }, 1500);
      }
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update plugin');
    } finally {
      setEditLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;

    setDeleteLoading(true);
    try {
      const response = await api.deletePlugin(deleteTarget.id);
      if (response.success) {
        setDeleteTarget(null);
        await fetchPlugins();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete plugin');
      setDeleteTarget(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const canDelete = (plugin: Plugin) => {
    if (isSysAdmin) return true;
    return plugin.accessModifier === 'private';
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
            <h1 className="text-2xl font-bold text-gray-900">Plugins</h1>
          </div>
          
          <div className="flex items-center space-x-4">
            {/* Access Filter - Only show to admins */}
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

            {/* Upload Button — admins only */}
            {isAdmin && (
              <button
                onClick={openUploadModal}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                Upload Plugin
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {/* Info banner for system admins */}
        {isSysAdmin && (
          <div className="mb-6 rounded-md bg-purple-50 p-4">
            <p className="text-sm text-purple-700">
              System Admin: Viewing all plugins across all organizations.
            </p>
          </div>
        )}

        {/* Info banner for org admins */}
        {isOrgAdminUser && !isSysAdmin && (
          <div className="mb-6 rounded-md bg-blue-50 p-4">
            <p className="text-sm text-blue-700">
              Organization Admin: Viewing and managing plugins for <strong>{user.organizationName || 'your organization'}</strong> only.
            </p>
          </div>
        )}

        {/* Info banner for regular users */}
        {!isAdmin && (
          <div className="mb-6 rounded-md bg-gray-50 p-4">
            <p className="text-sm text-gray-700">
              Viewing private plugins for your organization.
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
        ) : filteredPlugins.length === 0 ? (
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
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            </svg>
            <h3 className="mt-4 text-lg font-medium text-gray-900">No plugins yet</h3>
            <p className="mt-2 text-sm text-gray-500">
              {isAdmin
                ? 'Get started by uploading your first plugin.'
                : 'No private plugins available for your organization.'}
            </p>
            {isAdmin && (
              <button
                onClick={openUploadModal}
                className="mt-4 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700"
              >
                Upload Plugin
              </button>
            )}
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
                    Version
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
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
                {filteredPlugins.map((plugin) => (
                  <tr key={plugin.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">{plugin.name}</div>
                      {plugin.description && (
                        <div className="text-sm text-gray-500 truncate max-w-xs">
                          {plugin.description}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {plugin.version}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {plugin.pluginType}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          plugin.accessModifier === 'public'
                            ? 'bg-green-100 text-green-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {plugin.accessModifier}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          plugin.isActive
                            ? 'bg-green-100 text-green-800'
                            : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {plugin.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <div className="flex items-center space-x-3">
                        {isSysAdmin || plugin.accessModifier === 'private' ? (
                          <button
                            onClick={() => openEditModal(plugin)}
                            className="text-blue-600 hover:text-blue-900 font-medium"
                          >
                            Edit
                          </button>
                        ) : (
                          <span className="text-gray-400 text-xs">Read-only</span>
                        )}
                        {canDelete(plugin) && (
                          <button
                            onClick={() => setDeleteTarget(plugin)}
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

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-medium text-gray-900">Upload Plugin</h2>
              <button
                onClick={() => setShowUploadModal(false)}
                className="text-gray-400 hover:text-gray-500"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {uploadError && (
              <div className="mb-4 rounded-md bg-red-50 p-3">
                <p className="text-sm text-red-800">{uploadError}</p>
              </div>
            )}
            {uploadSuccess && (
              <div className="mb-4 rounded-md bg-green-50 p-3">
                <p className="text-sm text-green-800">{uploadSuccess}</p>
              </div>
            )}

            <div className="space-y-4">
              {/* File Input */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Plugin File (.zip or .tar.gz)
                </label>
                <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 border-dashed rounded-md hover:border-gray-400 transition-colors">
                  <div className="space-y-1 text-center">
                    <svg
                      className="mx-auto h-12 w-12 text-gray-400"
                      stroke="currentColor"
                      fill="none"
                      viewBox="0 0 48 48"
                    >
                      <path
                        d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <div className="flex text-sm text-gray-600">
                      <label
                        htmlFor="file-upload"
                        className="relative cursor-pointer bg-white rounded-md font-medium text-blue-600 hover:text-blue-500 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-blue-500"
                      >
                        <span>Select a file</span>
                        <input
                          id="file-upload"
                          name="file-upload"
                          type="file"
                          className="sr-only"
                          ref={fileInputRef}
                          accept=".zip,.tar.gz,.tgz"
                          onChange={handleFileSelect}
                          disabled={uploadLoading}
                        />
                      </label>
                      <p className="pl-1">or drag and drop</p>
                    </div>
                    <p className="text-xs text-gray-500">ZIP or TAR.GZ up to 100MB</p>
                  </div>
                </div>
                {uploadFile && (
                  <p className="mt-2 text-sm text-gray-600">
                    Selected: <span className="font-medium">{uploadFile.name}</span>
                    <span className="text-gray-400 ml-2">
                      ({(uploadFile.size / 1024 / 1024).toFixed(2)} MB)
                    </span>
                  </p>
                )}
              </div>

              {/* Access Modifier */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Access Level
                </label>
                <select
                  value={uploadAccess}
                  onChange={(e) => setUploadAccess(e.target.value as 'public' | 'private')}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  disabled={uploadLoading || !canUploadPublic}
                >
                  <option value="private">Private (Organization only)</option>
                  {canUploadPublic && (
                    <option value="public">Public (Available to all)</option>
                  )}
                </select>
                {!canUploadPublic && (
                  <p className="mt-1 text-xs text-gray-500">
                    Only admins can upload public plugins
                  </p>
                )}
              </div>
            </div>

            <div className="mt-6 flex justify-end space-x-3">
              <button
                onClick={() => setShowUploadModal(false)}
                disabled={uploadLoading}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                disabled={uploadLoading || !uploadFile}
                className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploadLoading ? (
                  <>
                    <LoadingSpinner size="sm" className="mr-2" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    Upload
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => !deleteLoading && setDeleteTarget(null)} />
            <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
              <h3 className="text-lg font-medium text-gray-900 mb-2">Delete Plugin</h3>
              <p className="text-sm text-gray-500 mb-1">
                Are you sure you want to delete <strong>{deleteTarget.name}</strong>?
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

      {/* Edit Plugin Modal */}
      {showEditModal && editPlugin && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4 sticky top-0 bg-white pb-2">
              <h2 className="text-lg font-medium text-gray-900">Edit Plugin</h2>
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
                    <p className="text-sm text-gray-700 font-mono bg-gray-50 px-2 py-1 rounded">{editPlugin.id}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Org ID</label>
                    <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{editPlugin.orgId}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Created By</label>
                    <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{editPlugin.createdBy}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Created At</label>
                    <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{new Date(editPlugin.createdAt).toLocaleString()}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Updated By</label>
                    <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{editPlugin.updatedBy}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Updated At</label>
                    <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{new Date(editPlugin.updatedAt).toLocaleString()}</p>
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-500 mb-1">Image Tag</label>
                    <p className="text-sm text-gray-700 font-mono bg-gray-50 px-2 py-1 rounded break-all">{editPlugin.imageTag}</p>
                  </div>
                  {editPlugin.dockerfile && (
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-gray-500 mb-1">Dockerfile</label>
                      <pre className="text-xs text-gray-700 bg-gray-50 px-2 py-1 rounded overflow-x-auto max-h-24">{editPlugin.dockerfile}</pre>
                    </div>
                  )}
                </div>
              </div>

              {/* Editable Fields Section */}
              <div className="border-b pb-4">
                <h3 className="text-sm font-medium text-gray-500 mb-3">Core Information</h3>
                
                {/* Name */}
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
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

                {/* Version */}
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Version</label>
                  <input
                    type="text"
                    value={editVersion}
                    onChange={(e) => setEditVersion(e.target.value)}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    disabled={editLoading}
                  />
                </div>
              </div>

              {/* Plugin Configuration */}
              <div className="border-b pb-4">
                <h3 className="text-sm font-medium text-gray-500 mb-3">Plugin Configuration</h3>
                
                <div className="grid grid-cols-2 gap-4 mb-3">
                  {/* Plugin Type */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Plugin Type</label>
                    <select
                      value={editPluginType}
                      onChange={(e) => setEditPluginType(e.target.value)}
                      className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                      disabled={editLoading}
                    >
                      <option value="CodeBuildStep">CodeBuildStep</option>
                      <option value="ShellStep">ShellStep</option>
                      <option value="ManualApprovalStep">ManualApprovalStep</option>
                    </select>
                  </div>

                  {/* Compute Type */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Compute Type</label>
                    <select
                      value={editComputeType}
                      onChange={(e) => setEditComputeType(e.target.value)}
                      className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                      disabled={editLoading}
                    >
                      <option value="SMALL">SMALL</option>
                      <option value="MEDIUM">MEDIUM</option>
                      <option value="LARGE">LARGE</option>
                      <option value="X2_LARGE">X2_LARGE</option>
                    </select>
                  </div>
                </div>

                {/* Metadata (JSON) */}
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Metadata (JSON)</label>
                  <textarea
                    value={editMetadata}
                    onChange={(e) => setEditMetadata(e.target.value)}
                    rows={3}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono text-xs"
                    disabled={editLoading}
                    placeholder='{"key": "value"}'
                  />
                </div>
              </div>

              {/* Build Configuration */}
              <div className="border-b pb-4">
                <h3 className="text-sm font-medium text-gray-500 mb-3">Build Configuration</h3>

                {/* Env (JSON) */}
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Environment Variables (JSON)</label>
                  <textarea
                    value={editEnv}
                    onChange={(e) => setEditEnv(e.target.value)}
                    rows={3}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono text-xs"
                    disabled={editLoading}
                    placeholder='{"API_URL": "https://api.example.com"}'
                  />
                </div>

                {/* Install Commands */}
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Install Commands (one per line)</label>
                  <textarea
                    value={editInstallCommands}
                    onChange={(e) => setEditInstallCommands(e.target.value)}
                    rows={3}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono text-xs"
                    disabled={editLoading}
                    placeholder="npm install&#10;pip install -r requirements.txt"
                  />
                </div>

                {/* Commands */}
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Commands (one per line)</label>
                  <textarea
                    value={editCommands}
                    onChange={(e) => setEditCommands(e.target.value)}
                    rows={3}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono text-xs"
                    disabled={editLoading}
                    placeholder="npm run build&#10;npm test"
                  />
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
                      id="editIsActive"
                      type="checkbox"
                      checked={editIsActive}
                      onChange={(e) => setEditIsActive(e.target.checked)}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      disabled={editLoading}
                    />
                    <label htmlFor="editIsActive" className="ml-2 block text-sm text-gray-700">
                      Active
                    </label>
                  </div>

                  {/* Is Default */}
                  <div className="flex items-center">
                    <input
                      id="editIsDefault"
                      type="checkbox"
                      checked={editIsDefault}
                      onChange={(e) => setEditIsDefault(e.target.checked)}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      disabled={editLoading}
                    />
                    <label htmlFor="editIsDefault" className="ml-2 block text-sm text-gray-700">
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