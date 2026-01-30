import { useEffect, useState, useRef } from 'react';
import { DashboardLayout, Header } from '@/components/layout';
import { Button, Card, CardContent, Badge, Input } from '@/components/ui';
import api from '@/lib/api';
import { Pipeline } from '@/types';
import { Plus, Search, GitBranch, MoreVertical, Filter, X, Upload } from 'lucide-react';
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
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [filters, setFilters] = useState<PipelineFilters>(defaultFilters);
  const [showFilters, setShowFilters] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newPipeline, setNewPipeline] = useState({
    project: '',
    organization: '',
    accessModifier: 'private' as 'public' | 'private',
    propsJson: '{}',
  });
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [propsError, setPropsError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      
      // Handle different response formats
      const data = response as any;
      const pipelineList = data.pipelines || data.data || (Array.isArray(data) ? data : []);
      setPipelines(pipelineList);
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

    // Validate and parse props JSON
    let props: Record<string, unknown> = {};
    try {
      props = JSON.parse(newPipeline.propsJson);
      if (typeof props !== 'object' || Array.isArray(props)) {
        setPropsError('Props must be a JSON object');
        return;
      }
      setPropsError('');
    } catch (e) {
      setPropsError('Invalid JSON format');
      return;
    }

    setIsCreating(true);
    setCreateError('');

    try {
      await api.createPipeline({
        project: newPipeline.project,
        organization: newPipeline.organization,
        props,
        accessModifier: 'private',
      });
      setShowCreate(false);
      setNewPipeline({ project: '', organization: '', accessModifier: 'private', propsJson: '{}' });
      fetchPipelines();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Creation failed');
    } finally {
      setIsCreating(false);
    }
  };

  const handleCloseModal = () => {
    setShowCreate(false);
    setNewPipeline({ project: '', organization: '', accessModifier: 'private', propsJson: '{}' });
    setCreateError('');
    setPropsError('');
  };

  const handlePropsFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      try {
        // Validate JSON
        JSON.parse(content);
        setNewPipeline({ ...newPipeline, propsJson: content });
        setPropsError('');
      } catch (e) {
        setPropsError('Invalid JSON file');
      }
    };
    reader.readAsText(file);
    
    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
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
            <Card className="w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
              <CardContent className="p-6">
                <h3 className="text-lg font-semibold mb-4">Create Pipeline</h3>
                
                {createError && (
                  <div className="mb-4 p-3 text-sm text-red-600 bg-red-50 rounded-lg">
                    {createError}
                  </div>
                )}

                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                  </div>

                  {/* Props JSON Editor */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Builder Props (JSON)
                      </label>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1"
                      >
                        <Upload className="h-3 w-3" />
                        Upload JSON
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json"
                        onChange={handlePropsFileUpload}
                        className="hidden"
                      />
                    </div>
                    <textarea
                      value={newPipeline.propsJson}
                      onChange={(e) => {
                        setNewPipeline({ ...newPipeline, propsJson: e.target.value });
                        setPropsError('');
                      }}
                      placeholder='{"builder1": {"key": "value"}, "builder2": {...}}'
                      rows={8}
                      className={`w-full px-3 py-2 rounded-lg border ${
                        propsError 
                          ? 'border-red-500 focus:ring-red-500' 
                          : 'border-gray-300 dark:border-gray-600 focus:ring-primary-500'
                      } bg-white dark:bg-gray-800 text-sm font-mono focus:outline-none focus:ring-2`}
                    />
                    {propsError && (
                      <p className="mt-1 text-xs text-red-500">{propsError}</p>
                    )}
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Enter BuilderProps as JSON object. Each key is a builder name with its configuration.
                    </p>
                  </div>
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
          <div className="flex gap-6">
            {/* Pipelines Grid */}
            <div className={`grid grid-cols-1 ${selectedPipeline ? 'md:grid-cols-1 lg:grid-cols-2' : 'md:grid-cols-2 lg:grid-cols-3'} gap-6 ${selectedPipeline ? 'flex-1' : 'w-full'}`}>
              {pipelines.map((pipeline) => (
                <Card 
                  key={pipeline.id} 
                  className={`hover:shadow-md transition-shadow cursor-pointer ${selectedPipeline?.id === pipeline.id ? 'ring-2 ring-primary-500' : ''}`}
                  onClick={() => setSelectedPipeline(selectedPipeline?.id === pipeline.id ? null : pipeline)}
                >
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between mb-4">
                      <div className="h-10 w-10 bg-green-100 dark:bg-green-900 rounded-lg flex items-center justify-center">
                        <GitBranch className="h-5 w-5 text-green-600 dark:text-green-400" />
                      </div>
                      <button 
                        className="p-1 text-gray-400 hover:text-gray-600"
                        onClick={(e) => e.stopPropagation()}
                      >
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

            {/* Pipeline Detail Panel */}
            {selectedPipeline && (
              <div className="w-96 flex-shrink-0">
                <Card className="sticky top-6">
                  <CardContent className="p-6">
                    <div className="flex items-center justify-between mb-6">
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                        Pipeline Details
                      </h3>
                      <button
                        onClick={() => setSelectedPipeline(null)}
                        className="p-1 text-gray-400 hover:text-gray-600"
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </div>

                    <div className="flex items-center mb-6">
                      <div className="h-12 w-12 bg-green-100 dark:bg-green-900 rounded-lg flex items-center justify-center mr-4">
                        <GitBranch className="h-6 w-6 text-green-600 dark:text-green-400" />
                      </div>
                      <div>
                        <h4 className="font-semibold text-gray-900 dark:text-white">
                          {selectedPipeline.pipelineName || `${selectedPipeline.project}/${selectedPipeline.organization}`}
                        </h4>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {selectedPipeline.project}
                        </p>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                          ID
                        </label>
                        <p className="text-sm text-gray-900 dark:text-white font-mono break-all">
                          {selectedPipeline.id}
                        </p>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            Project
                          </label>
                          <p className="text-sm text-gray-900 dark:text-white">
                            {selectedPipeline.project}
                          </p>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            Organization
                          </label>
                          <p className="text-sm text-gray-900 dark:text-white">
                            {selectedPipeline.organization}
                          </p>
                        </div>
                      </div>

                      {selectedPipeline.pipelineName && (
                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            Pipeline Name
                          </label>
                          <p className="text-sm text-gray-900 dark:text-white">
                            {selectedPipeline.pipelineName}
                          </p>
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            Status
                          </label>
                          <Badge variant={selectedPipeline.isActive ? 'success' : 'default'}>
                            {selectedPipeline.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            Access
                          </label>
                          <Badge variant={selectedPipeline.accessModifier === 'public' ? 'info' : 'default'}>
                            {selectedPipeline.accessModifier}
                          </Badge>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            Default
                          </label>
                          <p className="text-sm text-gray-900 dark:text-white">
                            {selectedPipeline.isDefault ? 'Yes' : 'No'}
                          </p>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            Created By
                          </label>
                          <p className="text-sm text-gray-900 dark:text-white">
                            {selectedPipeline.createdBy || '-'}
                          </p>
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                          Props
                        </label>
                        <pre className="text-xs text-gray-900 dark:text-white font-mono bg-gray-100 dark:bg-gray-800 p-3 rounded-lg overflow-auto max-h-48">
                          {JSON.stringify(selectedPipeline.props, null, 2)}
                        </pre>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                          Created At
                        </label>
                        <p className="text-sm text-gray-900 dark:text-white">
                          {formatDate(selectedPipeline.createdAt)}
                        </p>
                      </div>

                      {selectedPipeline.updatedAt && (
                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            Updated At
                          </label>
                          <p className="text-sm text-gray-900 dark:text-white">
                            {formatDate(selectedPipeline.updatedAt)}
                          </p>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
