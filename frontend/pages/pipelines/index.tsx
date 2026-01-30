import { useEffect, useState } from 'react';
import { DashboardLayout, Header } from '@/components/layout';
import { Button, Card, CardContent, Badge, Input } from '@/components/ui';
import api from '@/lib/api';
import { Pipeline } from '@/types';
import { Plus, Search, GitBranch, MoreVertical, Filter, X } from 'lucide-react';
import { formatDate } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';

interface PipelineFilters {
  pipelineName: string;
  project: string;
  organization: string;
  isActive: string;
  isDefault: string;
  accessModifier: string;
}

const defaultFilters: PipelineFilters = {
  pipelineName: '',
  project: '',
  organization: '',
  isActive: '',
  isDefault: '',
  accessModifier: 'private',
};

export default function PipelinesPage() {
  const { user } = useAuth();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filters, setFilters] = useState<PipelineFilters>(defaultFilters);
  const [showFilters, setShowFilters] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newPipeline, setNewPipeline] = useState({
    project: '',
    organization: '',
    accessModifier: 'private' as 'public' | 'private',
  });
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const isAdmin = user?.role === 'admin';

  const fetchPipelines = async () => {
    try {
      setIsLoading(true);
      const params: Record<string, string> = {};
      
      // Add all non-empty filters to params
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params[key] = value;
      });
      
      const response = await api.listPipelines(params);
      console.log('[Pipelines] API response:', response);
      
      if (response.success) {
        // Handle different response formats
        const data = response as any;
        const pipelineList = data.pipelines || data.data || (Array.isArray(data) ? data : []);
        setPipelines(pipelineList);
      }
    } catch (error) {
      console.error('Failed to fetch pipelines:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPipelines();
  }, [filters]);

  const handleFilterChange = (key: keyof PipelineFilters, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  const clearFilters = () => {
    setFilters(defaultFilters);
  };

  const hasActiveFilters = Object.values(filters).some(v => v !== '');

  const handleCreate = async () => {
    if (!newPipeline.project || !newPipeline.organization) {
      setCreateError('Project and organization are required');
      return;
    }

    setIsCreating(true);
    setCreateError('');

    try {
      await api.createPipeline({
        project: newPipeline.project,
        organization: newPipeline.organization,
        props: {},
        accessModifier: newPipeline.accessModifier,
      });
      setShowCreate(false);
      setNewPipeline({ project: '', organization: '', accessModifier: 'private' });
      fetchPipelines();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Creation failed');
    } finally {
      setIsCreating(false);
    }
  };

  const handleCloseModal = () => {
    setShowCreate(false);
    setNewPipeline({ project: '', organization: '', accessModifier: 'private' });
    setCreateError('');
  };

  return (
    <DashboardLayout>
      <Header title="Pipelines" description="Manage your pipeline configurations" />

      <div className="p-6">
        {/* Actions Bar */}
        <div className="flex flex-col sm:flex-row gap-4 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              type="search"
              placeholder="Search by name..."
              value={filters.pipelineName}
              onChange={(e) => handleFilterChange('pipelineName', e.target.value)}
              className="pl-10"
            />
          </div>
          <Button variant="secondary" onClick={() => setShowFilters(!showFilters)}>
            <Filter className="h-4 w-4 mr-2" />
            Filters
            {hasActiveFilters && (
              <span className="ml-2 h-5 w-5 rounded-full bg-primary-500 text-white text-xs flex items-center justify-center">
                {Object.values(filters).filter(v => v !== '').length}
              </span>
            )}
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Create Pipeline
          </Button>
        </div>

        {/* Filter Panel */}
        {showFilters && (
          <Card className="mb-6">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Filter Pipelines</h3>
                {hasActiveFilters && (
                  <button
                    onClick={clearFilters}
                    className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1"
                  >
                    <X className="h-3 w-3" />
                    Clear all
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Project
                  </label>
                  <Input
                    type="text"
                    placeholder="e.g., my-project"
                    value={filters.project}
                    onChange={(e) => handleFilterChange('project', e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Organization
                  </label>
                  <Input
                    type="text"
                    placeholder="e.g., my-org"
                    value={filters.organization}
                    onChange={(e) => handleFilterChange('organization', e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Access
                  </label>
                  <select
                    value={filters.accessModifier}
                    onChange={(e) => handleFilterChange('accessModifier', e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="">All</option>
                    <option value="public">Public</option>
                    <option value="private">Private</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Status
                  </label>
                  <select
                    value={filters.isActive}
                    onChange={(e) => handleFilterChange('isActive', e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="">All</option>
                    <option value="true">Active</option>
                    <option value="false">Inactive</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Default
                  </label>
                  <select
                    value={filters.isDefault}
                    onChange={(e) => handleFilterChange('isDefault', e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="">All</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Create Modal */}
        {showCreate && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <Card className="w-full max-w-md mx-4">
              <CardContent className="p-6">
                <h3 className="text-lg font-semibold mb-4">Create Pipeline</h3>
                
                {createError && (
                  <div className="mb-4 p-3 text-sm text-red-600 bg-red-50 rounded-lg">
                    {createError}
                  </div>
                )}

                <div className="space-y-4">
                  <Input
                    label="Project"
                    placeholder="my-project"
                    value={newPipeline.project}
                    onChange={(e) => setNewPipeline({ ...newPipeline, project: e.target.value })}
                  />
                  <Input
                    label="Organization"
                    placeholder="my-org"
                    value={newPipeline.organization}
                    onChange={(e) => setNewPipeline({ ...newPipeline, organization: e.target.value })}
                  />
                  
                  {/* Access Modifier Selection - Admin Only */}
                  {isAdmin && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        Access Modifier
                      </label>
                      <div className="flex gap-3">
                        <label className="flex items-center">
                          <input
                            type="radio"
                            name="createAccessModifier"
                            value="private"
                            checked={newPipeline.accessModifier === 'private'}
                            onChange={(e) => setNewPipeline({ ...newPipeline, accessModifier: e.target.value as 'private' })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                          />
                          <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                            Private
                          </span>
                        </label>
                        <label className="flex items-center">
                          <input
                            type="radio"
                            name="createAccessModifier"
                            value="public"
                            checked={newPipeline.accessModifier === 'public'}
                            onChange={(e) => setNewPipeline({ ...newPipeline, accessModifier: e.target.value as 'public' })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                          />
                          <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                            Public
                          </span>
                        </label>
                      </div>
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        Public pipelines are visible to all organizations
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex justify-end gap-3 mt-6">
                  <Button variant="secondary" onClick={handleCloseModal}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreate} isLoading={isCreating}>
                    Create
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Pipelines Grid */}
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
        ) : pipelines.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <GitBranch className="h-12 w-12 mx-auto text-gray-400 mb-4" />
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                No pipelines yet
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                Create your first pipeline to get started
              </p>
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create Pipeline
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {pipelines.map((pipeline) => (
              <Card key={pipeline.id} className="hover:shadow-md transition-shadow">
                <CardContent className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div className="h-10 w-10 bg-green-100 dark:bg-green-900 rounded-lg flex items-center justify-center">
                      <GitBranch className="h-5 w-5 text-green-600 dark:text-green-400" />
                    </div>
                    <button className="p-1 text-gray-400 hover:text-gray-600">
                      <MoreVertical className="h-5 w-5" />
                    </button>
                  </div>
                  
                  <h3 className="font-semibold text-gray-900 dark:text-white mb-1">
                    {pipeline.pipelineName || `${pipeline.project}/${pipeline.organization}`}
                  </h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                    {pipeline.project}
                  </p>

                  <div className="flex flex-wrap gap-2 mb-4">
                    <Badge variant={pipeline.isActive ? 'success' : 'default'}>
                      {pipeline.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                    <Badge variant={pipeline.accessModifier === 'public' ? 'info' : 'default'}>
                      {pipeline.accessModifier}
                    </Badge>
                    {pipeline.isDefault && (
                      <Badge variant="warning">Default</Badge>
                    )}
                  </div>

                  <p className="text-xs text-gray-400">
                    Created {formatDate(pipeline.createdAt)}
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
