import { useState, useRef } from 'react';
import { BuilderProps } from '@/types';
import { LoadingSpinner } from '@/components/ui/Loading';
import UploadConfigTab, { UploadConfigTabRef } from './UploadConfigTab';
import FormBuilderTab, { FormBuilderTabRef } from './FormBuilderTab';

interface CreatePipelineModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (props: BuilderProps, accessModifier: 'public' | 'private') => Promise<void>;
  createLoading: boolean;
  createError: string | null;
  createSuccess: string | null;
  canCreatePublic: boolean;
}

export default function CreatePipelineModal({
  isOpen, onClose, onSubmit,
  createLoading, createError, createSuccess, canCreatePublic,
}: CreatePipelineModalProps) {
  const [activeTab, setActiveTab] = useState<'upload' | 'form'>('upload');
  const [createAccess, setCreateAccess] = useState<'public' | 'private'>('private');
  const [showPreview, setShowPreview] = useState(false);
  const [previewJson, setPreviewJson] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const uploadRef = useRef<UploadConfigTabRef>(null);
  const formRef = useRef<FormBuilderTabRef>(null);

  if (!isOpen) return null;

  const resolveProps = async (): Promise<BuilderProps | null> => {
    if (activeTab === 'upload') {
      return await uploadRef.current?.getProps() ?? null;
    }
    return formRef.current?.getProps() ?? null;
  };

  const handlePreview = async () => {
    setPreviewError(null);
    const props = await resolveProps();
    if (props) {
      setPreviewJson(JSON.stringify(props, null, 2));
      setShowPreview(true);
    } else {
      setPreviewError('Fix validation errors above before previewing.');
    }
  };

  const handleSubmit = async () => {
    const props = await resolveProps();
    if (!props) return;
    await onSubmit(props, createAccess);
  };

  const isSubmitDisabled = createLoading;

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-medium text-gray-900">Create Pipeline</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 px-6">
          <nav className="-mb-px flex space-x-8">
            <button
              onClick={() => setActiveTab('upload')}
              className={`py-3 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'upload'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Upload Configuration
            </button>
            <button
              onClick={() => setActiveTab('form')}
              className={`py-3 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'form'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Form Builder
            </button>
          </nav>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {createError && (
            <div className="mb-4 rounded-md bg-red-50 p-3">
              <p className="text-sm text-red-800">{createError}</p>
            </div>
          )}
          {createSuccess && (
            <div className="mb-4 rounded-md bg-green-50 p-3">
              <p className="text-sm text-green-800">{createSuccess}</p>
            </div>
          )}

          {activeTab === 'upload' ? (
            <UploadConfigTab ref={uploadRef} disabled={createLoading} />
          ) : (
            <FormBuilderTab ref={formRef} disabled={createLoading} />
          )}

          {previewError && (
            <div className="mt-4 rounded-md bg-yellow-50 p-3">
              <p className="text-sm text-yellow-800">{previewError}</p>
            </div>
          )}

          {/* JSON Preview Panel */}
          {showPreview && previewJson && (
            <div className="mt-4 border border-gray-200 rounded-md">
              <div className="flex items-center justify-between px-4 py-2 bg-gray-100 border-b border-gray-200 rounded-t-md">
                <span className="text-sm font-medium text-gray-700">JSON Preview</span>
                <button
                  onClick={() => setShowPreview(false)}
                  className="text-gray-400 hover:text-gray-600 text-sm"
                >
                  Close
                </button>
              </div>
              <pre className="p-4 text-xs font-mono text-gray-800 overflow-x-auto max-h-64 overflow-y-auto bg-gray-50 rounded-b-md">
                {previewJson}
              </pre>
            </div>
          )}
        </div>

        {/* Footer - shared access modifier + submit */}
        <div className="border-t border-gray-200 px-6 py-4 bg-gray-50 rounded-b-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <label htmlFor="pipelineAccess" className="text-sm font-medium text-gray-700">
                Access:
              </label>
              <select
                id="pipelineAccess"
                value={createAccess}
                onChange={(e) => setCreateAccess(e.target.value as 'public' | 'private')}
                className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                disabled={createLoading || !canCreatePublic}
              >
                <option value="private">Private</option>
                {canCreatePublic && <option value="public">Public</option>}
              </select>
              {!canCreatePublic && (
                <span className="text-xs text-gray-500">Only admins can create public pipelines</span>
              )}
            </div>

            <div className="flex items-center space-x-3">
              <button
                onClick={handlePreview}
                disabled={createLoading}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Preview JSON
              </button>
              <button
                onClick={onClose}
                disabled={createLoading}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitDisabled}
                className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createLoading ? (
                  <>
                    <LoadingSpinner size="sm" className="mr-2" />
                    Creating...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Create
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
