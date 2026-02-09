import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';
import { Pipeline, BuilderProps } from '@/types';

interface EditPipelineModalProps {
  pipeline: Pipeline;
  isSysAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function EditPipelineModal({ pipeline, isSysAdmin, onClose, onSaved }: EditPipelineModalProps) {
  const [pipelineName, setPipelineName] = useState(pipeline.pipelineName || '');
  const [description, setDescription] = useState(pipeline.description || '');
  const [keywords, setKeywords] = useState(pipeline.keywords?.join(', ') || '');
  const [props, setProps] = useState(JSON.stringify(pipeline.props || {}, null, 2));
  const [isActive, setIsActive] = useState(pipeline.isActive);
  const [isDefault, setIsDefault] = useState(pipeline.isDefault);
  const [accessModifier, setAccessModifier] = useState<'public' | 'private'>(pipeline.accessModifier);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    let parsedProps: BuilderProps;
    try {
      parsedProps = props.trim() ? JSON.parse(props) : {};
    } catch {
      setError('Invalid JSON in props field');
      setLoading(false);
      return;
    }

    try {
      const response = await api.updatePipeline(pipeline.id, {
        pipelineName,
        description,
        keywords: keywords.split(',').map(k => k.trim()).filter(k => k),
        props: parsedProps,
        isActive,
        isDefault,
        accessModifier,
      });

      if (response.success) {
        setSuccess('Pipeline updated successfully!');
        onSaved();
        setTimeout(() => onClose(), 1500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update pipeline');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4 sticky top-0 bg-white pb-2">
          <h2 className="text-lg font-medium text-gray-900">Edit Pipeline</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-md bg-red-50 p-3">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}
        {success && (
          <div className="mb-4 rounded-md bg-green-50 p-3">
            <p className="text-sm text-green-800">{success}</p>
          </div>
        )}

        <div className="space-y-4">
          {/* Read-only Fields */}
          <div className="border-b pb-4">
            <h3 className="text-sm font-medium text-gray-500 mb-3">System Information (Read-only)</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">ID</label>
                <p className="text-sm text-gray-700 font-mono bg-gray-50 px-2 py-1 rounded">{pipeline.id}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Org ID</label>
                <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{pipeline.orgId}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Project</label>
                <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{pipeline.project}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Organization</label>
                <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{pipeline.organization}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Created By</label>
                <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{pipeline.createdBy}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Created At</label>
                <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{new Date(pipeline.createdAt).toLocaleString()}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Updated By</label>
                <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{pipeline.updatedBy}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Updated At</label>
                <p className="text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">{new Date(pipeline.updatedAt).toLocaleString()}</p>
              </div>
            </div>
          </div>

          {/* Core Information */}
          <div className="border-b pb-4">
            <h3 className="text-sm font-medium text-gray-500 mb-3">Core Information</h3>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Pipeline Name</label>
              <input type="text" value={pipelineName} onChange={(e) => setPipelineName(e.target.value)} className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm" disabled={loading} />
            </div>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm" disabled={loading} />
            </div>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Keywords (comma-separated)</label>
              <input type="text" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="keyword1, keyword2, keyword3" className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm" disabled={loading} />
            </div>
          </div>

          {/* Pipeline Configuration */}
          <div className="border-b pb-4">
            <h3 className="text-sm font-medium text-gray-500 mb-3">Pipeline Configuration</h3>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Props (JSON)</label>
              <textarea value={props} onChange={(e) => setProps(e.target.value)} rows={8} className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono text-xs" disabled={loading} placeholder='{"project": "my-project", "organization": "my-org"}' />
              <p className="mt-1 text-xs text-gray-500">Builder configuration including project, organization, and pipeline settings</p>
            </div>
          </div>

          {/* Access & Status */}
          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-3">Access & Status</h3>
            <div className="grid grid-cols-2 gap-4 mb-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Access Modifier</label>
                <select value={accessModifier} onChange={(e) => setAccessModifier(e.target.value as 'public' | 'private')} className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm disabled:bg-gray-100 disabled:text-gray-500" disabled={loading || !isSysAdmin}>
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
                {!isSysAdmin && (
                  <p className="text-xs text-gray-400 mt-1">Only system admins can change access level</p>
                )}
              </div>
            </div>
            <div className="flex items-center space-x-6">
              <div className="flex items-center">
                <input id="editPipelineIsActive" type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded" disabled={loading} />
                <label htmlFor="editPipelineIsActive" className="ml-2 block text-sm text-gray-700">Active</label>
              </div>
              <div className="flex items-center">
                <input id="editPipelineIsDefault" type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded" disabled={loading} />
                <label htmlFor="editPipelineIsDefault" className="ml-2 block text-sm text-gray-700">Default</label>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end space-x-3 sticky bottom-0 bg-white pt-4">
          <button onClick={onClose} disabled={loading} className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500">
            Cancel
          </button>
          <button onClick={handleSave} disabled={loading} className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed">
            {loading ? (<><LoadingSpinner size="sm" className="mr-2" />Saving...</>) : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
