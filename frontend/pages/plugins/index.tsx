import { useEffect, useState, useRef } from 'react';
import { DashboardLayout, Header } from '@/components/layout';
import { Button, Card, CardContent, Badge, Input } from '@/components/ui';
import api from '@/lib/api';
import { Plugin } from '@/types';
import { Plus, Search, Upload, Puzzle, MoreVertical } from 'lucide-react';
import { formatDate } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';

export default function PluginsPage() {
  const { user } = useAuth();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [accessModifier, setAccessModifier] = useState<'public' | 'private'>('private');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isAdmin = user?.role === 'admin';

  const fetchPlugins = async () => {
    try {
      setIsLoading(true);
      const params: Record<string, string> = {};
      if (searchQuery) params.name = searchQuery;
      
      const response = await api.getPlugin(params);
      if (response.success) {
        setPlugins((response as { plugins?: Plugin[] }).plugins || []);
      }
    } catch (error) {
      console.error('Failed to fetch plugins:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPlugins();
  }, [searchQuery]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.name.endsWith('.zip')) {
        setUploadError('Only ZIP files are allowed');
        return;
      }
      setUploadFile(file);
      setUploadError('');
    }
  };

  const handleUpload = async () => {
    if (!uploadFile) return;

    setIsUploading(true);
    setUploadError('');

    try {
      await api.uploadPlugin(uploadFile, accessModifier);
      setShowUpload(false);
      setUploadFile(null);
      setAccessModifier('private');
      fetchPlugins();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  };

  const handleCloseModal = () => {
    setShowUpload(false);
    setUploadFile(null);
    setUploadError('');
    setAccessModifier('private');
  };

  return (
    <DashboardLayout>
      <Header title="Plugins" description="Manage your plugin library" />

      <div className="p-6">
        {/* Actions Bar */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              type="search"
              placeholder="Search plugins..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <Button onClick={() => setShowUpload(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Upload Plugin
          </Button>
        </div>

        {/* Upload Modal */}
        {showUpload && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <Card className="w-full max-w-md mx-4">
              <CardContent className="p-6">
                <h3 className="text-lg font-semibold mb-4">Upload Plugin</h3>
                
                {uploadError && (
                  <div className="mb-4 p-3 text-sm text-red-600 bg-red-50 rounded-lg">
                    {uploadError}
                  </div>
                )}

                <div
                  className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-8 text-center cursor-pointer hover:border-primary-500 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-10 w-10 mx-auto text-gray-400 mb-3" />
                  {uploadFile ? (
                    <p className="text-sm text-gray-900 dark:text-white font-medium">
                      {uploadFile.name}
                    </p>
                  ) : (
                    <>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        Click to select a ZIP file
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        Maximum file size: 100MB
                      </p>
                    </>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".zip"
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                </div>

                {/* Access Modifier Selection - Admin Only */}
                {isAdmin && (
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Access Modifier
                    </label>
                    <div className="flex gap-3">
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="accessModifier"
                          value="private"
                          checked={accessModifier === 'private'}
                          onChange={(e) => setAccessModifier(e.target.value as 'private')}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                          Private
                        </span>
                      </label>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="accessModifier"
                          value="public"
                          checked={accessModifier === 'public'}
                          onChange={(e) => setAccessModifier(e.target.value as 'public')}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                          Public
                        </span>
                      </label>
                    </div>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Public plugins are visible to all organizations
                    </p>
                  </div>
                )}

                <div className="flex justify-end gap-3 mt-6">
                  <Button variant="secondary" onClick={handleCloseModal}>
                    Cancel
                  </Button>
                  <Button onClick={handleUpload} isLoading={isUploading} disabled={!uploadFile}>
                    Upload
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Plugins Grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[...Array(6)].map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-6">
                  <div className="h-10 w-10 bg-gray-200 dark:bg-gray-700 rounded-lg mb-4" />
                  <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-2" />
                  <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-1/2" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : plugins.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Puzzle className="h-12 w-12 mx-auto text-gray-400 mb-4" />
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                No plugins yet
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                Upload your first plugin to get started
              </p>
              <Button onClick={() => setShowUpload(true)}>
                <Upload className="h-4 w-4 mr-2" />
                Upload Plugin
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {plugins.map((plugin) => (
              <Card key={plugin.id} className="hover:shadow-md transition-shadow">
                <CardContent className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div className="h-10 w-10 bg-blue-100 dark:bg-blue-900 rounded-lg flex items-center justify-center">
                      <Puzzle className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                    </div>
                    <button className="p-1 text-gray-400 hover:text-gray-600">
                      <MoreVertical className="h-5 w-5" />
                    </button>
                  </div>
                  
                  <h3 className="font-semibold text-gray-900 dark:text-white mb-1">
                    {plugin.name}
                  </h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                    v{plugin.version}
                  </p>

                  <div className="flex flex-wrap gap-2 mb-4">
                    <Badge variant={plugin.isActive ? 'success' : 'default'}>
                      {plugin.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                    <Badge variant={plugin.accessModifier === 'public' ? 'info' : 'default'}>
                      {plugin.accessModifier}
                    </Badge>
                    {plugin.pluginType && (
                      <Badge>{plugin.pluginType}</Badge>
                    )}
                  </div>

                  <p className="text-xs text-gray-400">
                    Created {formatDate(plugin.createdAt)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
