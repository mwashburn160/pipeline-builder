import { useState, useRef, useEffect } from 'react';
import { Plus, ChevronLeft, ChevronRight, ShieldCheck } from 'lucide-react';
import { BuilderProps } from '@/types';
import type { ComplianceCheckResult } from '@/types/compliance';
import { Badge } from '@/components/ui/Badge';
import api from '@/lib/api';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import GitUrlTab, { GitUrlTabRef } from './GitUrlTab';
import UploadConfigTab, { UploadConfigTabRef } from './UploadConfigTab';
import FormBuilderTab, { FormBuilderTabRef } from './FormBuilderTab';
import { WIZARD_STEPS } from '@/lib/wizard-validation';
import { formatJSON } from '@/lib/constants';

/** Props for {@link CreatePipelineModal}. */
interface CreatePipelineModalProps {
  /** Whether the modal is currently visible. */
  isOpen: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback invoked with assembled BuilderProps when the user submits. */
  onSubmit: (props: BuilderProps, accessModifier: 'public' | 'private', description?: string, keywords?: string[]) => Promise<void>;
  /** Whether a create request is in flight. */
  createLoading: boolean;
  /** Error message from the last create attempt, if any. */
  createError: string | null;
  /** Success message from the last create attempt, if any. */
  createSuccess: string | null;
  /** Whether the current user is allowed to create public pipelines. */
  canCreatePublic: boolean;
  /** Optional pre-filled Git URL (opens on Git URL tab and starts generation). */
  initialGitUrl?: string;
}

/**
 * Modal for creating a new pipeline configuration.
 *
 * Offers three input modes via tabs: Git URL (repo analysis + AI generation),
 * Upload (JSON file/paste), and Wizard (step-by-step form). The Wizard tab uses a
 * multi-step flow with Previous/Next navigation, while the other tabs submit directly.
 */
export default function CreatePipelineModal({
  isOpen, onClose, onSubmit,
  createLoading, createError, createSuccess, canCreatePublic, initialGitUrl,
}: CreatePipelineModalProps) {
  const [activeTab, setActiveTab] = useState<'upload' | 'form' | 'ai'>('ai');
  const [createAccess, setCreateAccess] = useState<'public' | 'private'>('private');
  const [showPreview, setShowPreview] = useState(false);
  const [previewJson, setPreviewJson] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [complianceResult, setComplianceResult] = useState<ComplianceCheckResult | null>(null);
  const [complianceLoading, setComplianceLoading] = useState(false);

  const uploadRef = useRef<UploadConfigTabRef>(null);
  const formRef = useRef<FormBuilderTabRef>(null);
  const aiRef = useRef<GitUrlTabRef>(null);
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
    if (activeTab === 'ai') {
      return await aiRef.current?.getProps() ?? null;
    }
    return formRef.current?.getProps() ?? null;
  };

  const handlePreview = async () => {
    setPreviewError(null);
    let props: BuilderProps | null = null;
    switch (activeTab) {
      case 'form':
        props = formRef.current?.getPropsPreview() ?? null;
        break;
      case 'upload':
        props = await uploadRef.current?.getProps() ?? null;
        break;
      case 'ai':
        props = await aiRef.current?.getProps() ?? null;
        break;
    }
    if (props) {
      setPreviewJson(formatJSON(props));
      setShowPreview(true);
    } else {
      setPreviewError('Fix validation errors above before previewing.');
    }
  };

  const handleSubmit = async () => {
    const props = await resolveProps();
    if (!props) return;
    // Description/keywords from upload or AI tabs
    let desc = '';
    let kw = '';
    switch (activeTab) {
      case 'upload':
        desc = uploadRef.current?.getDescription() ?? '';
        kw = uploadRef.current?.getKeywords() ?? '';
        break;
      case 'ai':
        desc = aiRef.current?.getDescription() ?? '';
        kw = aiRef.current?.getKeywords() ?? '';
        break;
    }
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

  const handleComplianceCheck = async () => {
    setComplianceLoading(true);
    setComplianceResult(null);
    try {
      const props = await resolveProps();
      if (!props) { setComplianceLoading(false); return; }
      const res = await api.dryRunPipelineCompliance(props as unknown as Record<string, unknown>);
      if (res.success && res.data) {
        setComplianceResult(res.data);
      }
    } catch {
      setComplianceResult({
        passed: false, blocked: false, rulesEvaluated: 0, rulesSkipped: 0,
        violations: [{ ruleId: 'error', ruleName: 'Compliance Check', field: '', operator: '', expectedValue: '', actualValue: '', severity: 'error', message: 'Failed to run compliance check' }],
        warnings: [], exemptionsApplied: [],
      });
    } finally {
      setComplianceLoading(false);
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
          onClick={() => setActiveTab('ai')}
          className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
            activeTab === 'ai'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
          }`}
        >
          Git URL
        </button>
        <button
          onClick={() => setActiveTab('upload')}
          className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
            activeTab === 'upload'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
          }`}
        >
          Upload
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
      <div className="flex items-center space-x-2">
        <button
          onClick={handlePreview}
          disabled={createLoading}
          className="btn btn-secondary"
        >
          Preview JSON
        </button>
        <button
          onClick={handleComplianceCheck}
          disabled={createLoading || complianceLoading}
          className="btn btn-secondary"
        >
          {complianceLoading ? <LoadingSpinner size="sm" className="mr-1" /> : <ShieldCheck className="w-4 h-4 mr-1" />}
          Preview Compliance
        </button>
      </div>

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
      ) : activeTab === 'ai' ? (
        <GitUrlTab ref={aiRef} disabled={createLoading} initialUrl={initialGitUrl} autoGenerate={!!initialGitUrl} />
      ) : (
        <FormBuilderTab
          ref={formRef}
          disabled={createLoading}
          showDescriptionKeywords={false}
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

      {complianceResult && (
        <div className={`mt-4 rounded-xl border p-4 ${complianceResult.passed ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : complianceResult.blocked ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800'}`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" />
              <span className="text-sm font-medium">Compliance Check ({complianceResult.rulesEvaluated} rules evaluated)</span>
            </div>
            <button onClick={() => setComplianceResult(null)} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">Dismiss</button>
          </div>
          {complianceResult.passed && complianceResult.warnings.length === 0 && (
            <p className="text-sm text-green-700 dark:text-green-300">All compliance checks passed.</p>
          )}
          {complianceResult.violations.map((v, i) => (
            <div key={`v-${i}`} className="flex items-start gap-2 mt-1">
              <Badge color="red">{v.severity === 'critical' ? 'Critical' : v.severity === 'error' ? 'Error' : 'Violation'}</Badge>
              <span className="text-sm text-gray-700 dark:text-gray-300">{v.message}</span>
            </div>
          ))}
          {complianceResult.warnings.map((w, i) => (
            <div key={`w-${i}`} className="flex items-start gap-2 mt-1">
              <Badge color="yellow">Warn</Badge>
              <span className="text-sm text-gray-700 dark:text-gray-300">{w.message}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
