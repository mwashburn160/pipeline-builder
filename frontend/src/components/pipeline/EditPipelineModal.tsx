import { useState, useRef, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';
import { Pipeline, BuilderProps } from '@/types';
import FormBuilderTab, { FormBuilderTabRef } from './FormBuilderTab';
import CollapsibleSection from './editors/CollapsibleSection';
import { WIZARD_STEPS } from './wizard-validation';

interface EditPipelineModalProps {
  pipeline: Pipeline;
  isSysAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function EditPipelineModal({ pipeline, isSysAdmin, onClose, onSaved }: EditPipelineModalProps) {
  const [activeTab, setActiveTab] = useState<'form' | 'json'>('form');
  const [jsonProps, setJsonProps] = useState(JSON.stringify(pipeline.props || {}, null, 2));
  const [isActive, setIsActive] = useState(pipeline.isActive);
  const [isDefault, setIsDefault] = useState(pipeline.isDefault);
  const [accessModifier, setAccessModifier] = useState<'public' | 'private'>(pipeline.accessModifier);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewJson, setPreviewJson] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState(0);

  const formRef = useRef<FormBuilderTabRef>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to top when step changes
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [currentStep]);

  const resolveProps = (): BuilderProps | null => {
    if (activeTab === 'form') {
      return formRef.current?.getProps() ?? null;
    }
    try {
      return jsonProps.trim() ? JSON.parse(jsonProps) : null;
    } catch {
      setError('Invalid JSON in props field');
      return null;
    }
  };

  const handlePreview = () => {
    setError(null);
    const props = resolveProps();
    if (props) {
      setPreviewJson(JSON.stringify(props, null, 2));
      setShowPreview(true);
    }
  };

  const handleNext = () => {
    if (formRef.current?.canProceed()) {
      const next = currentStep + 1;
      setCurrentStep(next);
      formRef.current?.goToStep(next);
    }
  };

  const handlePrevious = () => {
    if (currentStep > 0) {
      const prev = currentStep - 1;
      setCurrentStep(prev);
      formRef.current?.goToStep(prev);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    const parsedProps = resolveProps();
    if (!parsedProps) {
      setLoading(false);
      return;
    }

    // Get description/keywords from form state
    const desc = formRef.current?.getDescription() ?? pipeline.description ?? '';
    const kw = formRef.current?.getKeywords() ?? pipeline.keywords?.join(', ') ?? '';

    try {
      const response = await api.updatePipeline(pipeline.id, {
        pipelineName: parsedProps.pipelineName,
        description: desc,
        keywords: kw.split(',').map(k => k.trim()).filter(k => k),
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

  const isLastStep = currentStep === WIZARD_STEPS.length - 1;

  const accessStatusSlot = (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
      <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Access & Status</h3>
      <div className="grid grid-cols-2 gap-4 mb-3">
        <div>
          <label className="label">Access Modifier</label>
          <select value={accessModifier} onChange={(e) => setAccessModifier(e.target.value as 'public' | 'private')} className="input disabled:bg-gray-100 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500" disabled={loading || !isSysAdmin}>
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
          {!isSysAdmin && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Only system admins can change access level</p>
          )}
        </div>
      </div>
      <div className="flex items-center space-x-6">
        <div className="flex items-center">
          <input id="editPipelineIsActive" type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded" disabled={loading} />
          <label htmlFor="editPipelineIsActive" className="ml-2 block text-sm text-gray-700 dark:text-gray-300">Active</label>
        </div>
        <div className="flex items-center">
          <input id="editPipelineIsDefault" type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded" disabled={loading} />
          <label htmlFor="editPipelineIsDefault" className="ml-2 block text-sm text-gray-700 dark:text-gray-300">Default</label>
        </div>
      </div>
    </div>
  );

  return (
    <div className="modal-backdrop">
      <div className="modal-panel max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">Edit Pipeline</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 transition-colors">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable Content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
          {error && (
            <div className="alert-error mb-4">
              <p>{error}</p>
            </div>
          )}
          {success && (
            <div className="alert-success mb-4">
              <p>{success}</p>
            </div>
          )}

          {/* System Information (collapsible, read-only) */}
          <div className="mb-4">
            <CollapsibleSection title="System Information" hasContent={true}>
              <div className="mt-3 grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">ID</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 font-mono bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{pipeline.id}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Org ID</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{pipeline.orgId}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Project</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{pipeline.project}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Organization</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{pipeline.organization}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Created By</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{pipeline.createdBy}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Created At</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{new Date(pipeline.createdAt).toLocaleString()}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Updated By</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{pipeline.updatedBy}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Updated At</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{new Date(pipeline.updatedAt).toLocaleString()}</p>
                </div>
              </div>
            </CollapsibleSection>
          </div>

          {/* Tabs: Wizard | Raw JSON */}
          <div className="border-b border-gray-200 dark:border-gray-700 pb-4 mb-4">
            <div className="border-b border-gray-200 dark:border-gray-700 mb-4">
              <nav className="-mb-px flex space-x-8">
                <button
                  onClick={() => setActiveTab('form')}
                  className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors ${
                    activeTab === 'form'
                      ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                >
                  Wizard
                </button>
                <button
                  onClick={() => setActiveTab('json')}
                  className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors ${
                    activeTab === 'json'
                      ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                >
                  Raw JSON
                </button>
              </nav>
            </div>

            {activeTab === 'form' ? (
              <FormBuilderTab
                ref={formRef}
                disabled={loading}
                initialProps={pipeline.props}
                initialDescription={pipeline.description || ''}
                initialKeywords={pipeline.keywords?.join(', ') || ''}
                wizardMode={true}
                currentStep={currentStep}
                onStepChange={setCurrentStep}
                accessStatusSlot={accessStatusSlot}
              />
            ) : (
              <div>
                <textarea
                  value={jsonProps}
                  onChange={(e) => setJsonProps(e.target.value)}
                  rows={12}
                  className="input font-mono text-xs"
                  disabled={loading}
                  placeholder='{"project": "my-project", "organization": "my-org"}'
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Builder configuration including project, organization, and pipeline settings
                </p>
              </div>
            )}
          </div>

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
            <button
              onClick={handlePreview}
              disabled={loading}
              className="btn btn-secondary"
            >
              Preview JSON
            </button>

            <div className="flex items-center space-x-3">
              <button onClick={onClose} disabled={loading} className="btn btn-secondary">
                Cancel
              </button>

              {activeTab === 'form' && currentStep > 0 && (
                <button onClick={handlePrevious} disabled={loading} className="btn btn-secondary">
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Previous
                </button>
              )}

              {activeTab === 'form' && !isLastStep ? (
                <button onClick={handleNext} disabled={loading} className="btn btn-primary">
                  Next
                  <ChevronRight className="w-4 h-4 ml-1" />
                </button>
              ) : (
                <button onClick={handleSave} disabled={loading} className="btn btn-primary">
                  {loading ? (<><LoadingSpinner size="sm" className="mr-2" />Saving...</>) : 'Save Changes'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
