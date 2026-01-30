import { useEffect, useState } from 'react';
import { DashboardLayout, Header } from '@/components/layout';
import { Button, Card, CardContent, Badge, Input } from '@/components/ui';
import api from '@/lib/api';
import { Pipeline } from '@/types';
import { Plus, Search, GitBranch, MoreVertical } from 'lucide-react';
import { formatDate } from '@/lib/utils';

export default function PipelinesPage() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newPipeline, setNewPipeline] = useState({
    project: '',
    organization: '',
    accessModifier: 'private' as 'public' | 'private',
  });
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const fetchPipelines = async () => {
    try {
      setIsLoading(true);
      const params: Record<string, string> = {};
      if (searchQuery) params.pipelineName = searchQuery;
      
      const response = await api.getPipeline(params);
      if (response.success) {
        setPipelines((response as { pipelines?: Pipeline[] }).pipelines || []);
      }
    } catch (error) {
      console.error('Failed to fetch pipelines:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPipelines();
  }, [searchQuery]);

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

  return (
    <DashboardLayout>
      <Header title="Pipelines" description="Manage your pipeline configurations" />

      <div className="p-6">
        {/* Actions Bar */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              type="search"
              placeholder="Search pipelines..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Create Pipeline
          </Button>
        </div>

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
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Access
                    </label>
                    <select
                      value={newPipeline.accessModifier}
                      onChange={(e) => setNewPipeline({ ...newPipeline, accessModifier: e.target.value as 'public' | 'private' })}
                      className="block w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-gray-900 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                    >
                      <option value="private">Private</option>
                      <option value="public">Public</option>
                    </select>
                  </div>
                </div>

                <div className="flex justify-end gap-3 mt-6">
                  <Button variant="secondary" onClick={() => {
                    setShowCreate(false);
                    setCreateError('');
                  }}>
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
