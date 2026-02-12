import { useState, useRef } from 'react';
import { Plus } from 'lucide-react';
import { BuilderProps } from '@/types';
import { LoadingSpinner } from '@/components/ui/Loading';
import UploadConfigTab, { UploadConfigTabRef } from './UploadConfigTab';
import FormBuilderTab, { FormBuilderTabRef } from './FormBuilderTab';

interface CreatePipelineModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (props: BuilderProps, accessModifier: 'public' | 'private', description?: string, keywords?: string[]) => Promise<void>;
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
    const desc = formRef.current?.getDescription() ?? '';
    const kw = formRef.current?.getKeywords() ?? '';
    const keywordsArray = kw.split(',').map(k => k.trim()).filter(k => k);
    await onSubmit(props, createAccess, desc || undefined, keywordsArray.length > 0 ? keywordsArray : undefined);
  };

  const isSubmitDisabled = createLoading;

  return (
    <div className="modal-backdrop">
      <div className="modal-panel max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">Create Pipeline</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 dark:border-gray-700 px-6">
          <nav className="-mb-px flex space-x-8">
            <button
              onClick={() => setActiveTab('upload')}
              className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'upload'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
              }`}
            >
              Upload Configuration
            </button>
            <button
              onClick={() => setActiveTab('form')}
              className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'form'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
              }`}
            >
              Form Builder
            </button>
          </nav>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {createError && (
            <div className="alert-error mb-4">
              <p>{createError}</p>
            </div>
          )}
          {createSuccess && (
            <div className="alert-success mb-4">
              <p>{createSuccess}</p>
            </div>
          )}

          {activeTab === 'upload' ? (
            <UploadConfigTab ref={uploadRef} disabled={createLoading} />
          ) : (
            <FormBuilderTab ref={formRef} disabled={createLoading} />
          )}

          {previewError && (
            <div className="mt-4 rounded-xl bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-3">
              <p className="text-sm text-yellow-800 dark:text-yellow-300">{previewError}</p>
            </div>
          )}

          {/* JSON Preview Panel */}
          {showPreview && previewJson && (
            <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">JSON Preview</span>
                <button
                  onClick={() => setShowPreview(false)}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm transition-colors"
                >
                  Close
                </button>
              </div>
              <pre className="p-4 text-xs font-mono text-gray-800 dark:text-gray-200 overflow-x-auto max-h-64 overflow-y-auto bg-gray-50 dark:bg-gray-900">
                {previewJson}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4 bg-gray-50 dark:bg-gray-800/50 rounded-b-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <label htmlFor="pipelineAccess" className="label !mb-0">
                Access:
              </label>
              <select
                id="pipelineAccess"
                value={createAccess}
                onChange={(e) => setCreateAccess(e.target.value as 'public' | 'private')}
                className="input !w-auto"
                disabled={createLoading || !canCreatePublic}
              >
                <option value="private">Private</option>
                {canCreatePublic && <option value="public">Public</option>}
              </select>
              {!canCreatePublic && (
                <span className="text-xs text-gray-500 dark:text-gray-400">Only admins can create public pipelines</span>
              )}
            </div>

            <div className="flex items-center space-x-3">
              <button
                onClick={handlePreview}
                disabled={createLoading}
                className="btn btn-secondary"
              >
                Preview JSON
              </button>
              <button
                onClick={onClose}
                disabled={createLoading}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitDisabled}
                className="btn btn-primary"
              >
                {createLoading ? (
                  <>
                    <LoadingSpinner size="sm" className="mr-2" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4 mr-2" />
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
