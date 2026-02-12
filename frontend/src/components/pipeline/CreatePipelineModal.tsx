import { useState, useRef, useEffect } from 'react';
import { Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import { BuilderProps } from '@/types';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import UploadConfigTab, { UploadConfigTabRef } from './UploadConfigTab';
import FormBuilderTab, { FormBuilderTabRef } from './FormBuilderTab';
import { WIZARD_STEPS } from './wizard-validation';

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
  const [activeTab, setActiveTab] = useState<'upload' | 'form'>('form');
  const [createAccess, setCreateAccess] = useState<'public' | 'private'>('private');
  const [showPreview, setShowPreview] = useState(false);
  const [previewJson, setPreviewJson] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState(0);

  const uploadRef = useRef<UploadConfigTabRef>(null);
  const formRef = useRef<FormBuilderTabRef>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to top when step changes
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [currentStep]);

  if (!isOpen) return null;

  const resolveProps = async (): Promise<BuilderProps | null> => {
    if (activeTab === 'upload') {
      return await uploadRef.current?.getProps() ?? null;
    }
    return formRef.current?.getProps() ?? null;
  };

  const handlePreview = async () => {
    setPreviewError(null);
    const props = activeTab === 'form'
      ? formRef.current?.getPropsPreview() ?? null
      : await uploadRef.current?.getProps() ?? null;
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

  const isSubmitDisabled = createLoading;
  const isWizardTab = activeTab === 'form';
  const isLastStep = currentStep === WIZARD_STEPS.length - 1;

  const accessSlot = (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
      <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Access</h3>
      <div className="flex items-center space-x-3">
        <select
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
    </div>
  );

  const tabs = (
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
          Wizard
        </button>
      </nav>
    </div>
  );

  const jsonPreview = showPreview && previewJson ? (
    <div className="border-t border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between px-6 py-2 bg-gray-100 dark:bg-gray-800">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">JSON Preview</span>
        <button
          onClick={() => setShowPreview(false)}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm transition-colors"
        >
          Close
        </button>
      </div>
      <pre className="px-6 py-4 text-xs font-mono text-gray-800 dark:text-gray-200 overflow-x-auto max-h-64 overflow-y-auto bg-gray-50 dark:bg-gray-900">
        {previewJson}
      </pre>
    </div>
  ) : undefined;

  const footer = (
    <div className="flex items-center justify-between">
      <button
        onClick={handlePreview}
        disabled={createLoading}
        className="btn btn-secondary"
      >
        Preview JSON
      </button>

      <div className="flex items-center space-x-3">
        <button
          onClick={onClose}
          disabled={createLoading}
          className="btn btn-secondary"
        >
          Cancel
        </button>

        {isWizardTab && currentStep > 0 && (
          <button onClick={handlePrevious} disabled={createLoading} className="btn btn-secondary">
            <ChevronLeft className="w-4 h-4 mr-1" />
            Previous
          </button>
        )}

        {isWizardTab && !isLastStep ? (
          <button onClick={handleNext} disabled={createLoading} className="btn btn-primary">
            Next
            <ChevronRight className="w-4 h-4 ml-1" />
          </button>
        ) : (
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
        )}
      </div>
    </div>
  );

  return (
    <Modal
      title="Create Pipeline"
      onClose={onClose}
      maxWidth="max-w-4xl"
      tall
      scrollRef={scrollRef}
      subHeader={tabs}
      preFooter={jsonPreview}
      footer={footer}
    >
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
        <FormBuilderTab
          ref={formRef}
          disabled={createLoading}
          wizardMode={true}
          currentStep={currentStep}
          onStepChange={setCurrentStep}
          accessStatusSlot={accessSlot}
        />
      )}

      {previewError && (
        <div className="mt-4 rounded-xl bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-3">
          <p className="text-sm text-yellow-800 dark:text-yellow-300">{previewError}</p>
        </div>
      )}
    </Modal>
  );
}
