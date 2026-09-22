import { useState, useRef, useEffect } from 'react';
import { Plus, ChevronLeft, ChevronRight, ShieldCheck } from 'lucide-react';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { FeatureLock } from '@/components/ui/FeatureLock';
import type { BuilderProps, Visibility } from '@/types';
import type { ComplianceCheckResult } from '@/types/compliance';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { VisibilitySelect, visibilityHint } from '@/components/ui/VisibilitySelect';
import { TabBar, type TabBarItem } from '@/components/ui/TabBar';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import api from '@/lib/api';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import GitUrlTab, { GitUrlTabRef } from './GitUrlTab';
import PromptGenerateTab, { PromptGenerateTabRef } from './PromptGenerateTab';
import UploadConfigTab, { UploadConfigTabRef } from './UploadConfigTab';
import FormBuilderTab, { FormBuilderTabRef } from './FormBuilderTab';
import { WIZARD_STEPS } from '@/lib/wizard-validation';
import { JsonPreviewPanel } from './JsonPreviewPanel';
import { useBuilderWizard } from '@/hooks/useBuilderWizard';
import { useIsDirty } from '@/hooks/useIsDirty';

/** Props for {@link CreatePipelineModal}. */
interface CreatePipelineModalProps {
  /** Whether the modal is currently visible. */
  isOpen: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback invoked with assembled BuilderProps when the user submits. */
  onSubmit: (props: BuilderProps, visibility: Visibility, description?: string, keywords?: string[]) => Promise<void>;
  /** Whether a create request is in flight. */
  createLoading: boolean;
  /** Error message from the last create attempt, if any. */
  createError: string | null;
  /** Success message from the last create attempt, if any. */
  createSuccess: string | null;
  /** `pipelines:publish` — required for the `public` rung of the visibility ladder. */
  canPublish: boolean;
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
  createLoading, createError, createSuccess, canPublish, initialGitUrl,
}: CreatePipelineModalProps) {
  const [activeTab, setActiveTab] = useState<'upload' | 'form' | 'ai' | 'prompt'>('ai');
  // AI generation is a paid feature. The two AI tabs (Git URL, From prompt) hit a
  // server-side `requireFeature('ai_generation')` gate — pre-gate them with an
  // upsell so an unentitled org sees why, instead of a 403 dead-end on submit.
  // (`useFeatureGate` carries the superadmin bypass, same as the nav.)
  const aiEnabled = useFeatureGate('ai_generation').entitled;
  // Preselect `org` — the backend's create default for pipelines (a pipeline is
  // a team asset); `private` stays an explicit opt-in personal draft.
  const [visibility, setVisibility] = useState<Visibility>('org');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [complianceResult, setComplianceResult] = useState<ComplianceCheckResult | null>(null);
  const [complianceLoading, setComplianceLoading] = useState(false);

  const uploadRef = useRef<UploadConfigTabRef>(null);
  const formRef = useRef<FormBuilderTabRef>(null);
  const { currentStep, setCurrentStep, next: handleNext, prev: handlePrevious, reset: resetWizard, scrollRef, preview } = useBuilderWizard(formRef);
  // The builder owns the bulk of the form, so it reports its own edits; the
  // fields this modal owns are compared here. Together they gate the discard prompt.
  const [formDirty, setFormDirty] = useState(false);
  const ownFieldsDirty = useIsDirty({ visibility });
  const aiRef = useRef<GitUrlTabRef>(null);
  const promptRef = useRef<PromptGenerateTabRef>(null);

  // Reset wizard/preview/compliance state whenever the modal (re)opens. The
  // component is rendered unconditionally and only gated by `if (!isOpen)`, so
  // without this a mid-flow close→reopen would restore stale step/preview/
  // compliance state while the child tabs remount empty (stepper desync).
  useEffect(() => {
    if (isOpen) {
      setActiveTab('ai');
      setVisibility('org');
      resetWizard();
      setPreviewError(null);
      setComplianceResult(null);
    }
  }, [isOpen, resetWizard]);

  if (!isOpen) return null;

  const resolveProps = async (): Promise<BuilderProps | null> => {
    if (activeTab === 'upload') {
      return await uploadRef.current?.getProps() ?? null;
    }
    if (activeTab === 'ai') {
      return await aiRef.current?.getProps() ?? null;
    }
    if (activeTab === 'prompt') {
      return await promptRef.current?.getProps() ?? null;
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
      case 'prompt':
        props = await promptRef.current?.getProps() ?? null;
        break;
    }
    if (!preview.show(props)) setPreviewError('Fix validation errors above before previewing.');
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
      case 'prompt':
        desc = promptRef.current?.getDescription() ?? '';
        kw = promptRef.current?.getKeywords() ?? '';
        break;
    }
    const keywordsArray = kw.split(',').map(k => k.trim()).filter(k => k);
    await onSubmit(props, visibility, desc || undefined, keywordsArray.length > 0 ? keywordsArray : undefined);
  };

  const handleComplianceCheck = async () => {
    setComplianceLoading(true);
    setComplianceResult(null);
    try {
      const props = await resolveProps();
      if (!props) { setComplianceLoading(false); return; }
      const res = await api.dryRunPipelineCompliance(props);
      if (res.success && res.data) {
        setComplianceResult(res.data);
      } else {
        // Synthesize a failure ComplianceCheckResult from the envelope so the
        // user sees the same display path as a real violation. Falls back
        // through error/message and finally a generic copy.
        const envelope = res as { error?: string; message?: string };
        const message = envelope.error ?? envelope.message ?? 'Compliance check failed';
        setComplianceResult({
          passed: false, blocked: false, rulesEvaluated: 0, rulesSkipped: 0,
          violations: [{ ruleId: 'error', ruleName: 'Compliance check', field: '', operator: '', expectedValue: '', actualValue: '', severity: 'error', message }],
          warnings: [], exemptionsApplied: [],
        });
      }
    } catch {
      setComplianceResult({
        passed: false, blocked: false, rulesEvaluated: 0, rulesSkipped: 0,
        violations: [{ ruleId: 'error', ruleName: 'Compliance check', field: '', operator: '', expectedValue: '', actualValue: '', severity: 'error', message: 'Failed to run compliance check' }],
        warnings: [], exemptionsApplied: [],
      });
    } finally {
      setComplianceLoading(false);
    }
  };

  // AI tab selected without the entitlement — show the upsell, block submit/preview
  // (they would 403 server-side), and skip the AI tab's generation calls.
  const aiGated = (activeTab === 'ai' || activeTab === 'prompt') && !aiEnabled;
  const isSubmitDisabled = createLoading || aiGated;
  const isWizardTab = activeTab === 'form';
  const isLastStep = currentStep === WIZARD_STEPS.length - 1;

  const accessSlot = (
    <div className="mt-4 pt-4 border-t border-default">
      <label htmlFor="create-pipeline-visibility" className="block text-sm font-medium text-fg-muted mb-3">Visibility</label>
      <VisibilitySelect
        id="create-pipeline-visibility"
        value={visibility}
        onChange={setVisibility}
        canPublish={canPublish}
        disabled={createLoading}
      />
      <p className="text-xs text-fg-subtle mt-1">{visibilityHint(canPublish, 'pipelines:publish')}</p>
    </div>
  );

  const tabItems: TabBarItem[] = [
    { id: 'ai', label: 'Git URL' },
    { id: 'prompt', label: 'From prompt' },
    { id: 'upload', label: 'Upload' },
    { id: 'form', label: 'Wizard' },
  ];

  const tabs = (
    <div className="px-6">
      <TabBar
        items={tabItems}
        activeId={activeTab}
        onSelect={(id) => setActiveTab(id as 'upload' | 'form' | 'ai' | 'prompt')}
        className="!mb-0"
      />
    </div>
  );

  const jsonPreview = <JsonPreviewPanel preview={preview} />;

  const footer = (
    <div className="flex items-center justify-between">
      <div className="flex items-center space-x-2">
        <Button
          variant="secondary"
          onClick={handlePreview}
          disabled={createLoading || aiGated}
        >
          Preview JSON
        </Button>
        <Button
          variant="secondary"
          onClick={handleComplianceCheck}
          disabled={createLoading || complianceLoading || aiGated}
        >
          {complianceLoading ? <LoadingSpinner size="sm" className="mr-1" /> : <ShieldCheck className="w-4 h-4 mr-1" />}
          Preview Compliance
        </Button>
      </div>

      <div className="flex items-center space-x-3">
        <Button
          variant="secondary"
          onClick={onClose}
          disabled={createLoading}
        >
          Cancel
        </Button>

        {isWizardTab && currentStep > 0 && (
          <Button variant="secondary" onClick={handlePrevious} disabled={createLoading}>
            <ChevronLeft className="w-4 h-4 mr-1" />
            Previous
          </Button>
        )}

        {isWizardTab && !isLastStep ? (
          <Button onClick={handleNext} disabled={createLoading}>
            Next
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        ) : (
          <Button
            onClick={handleSubmit}
            disabled={isSubmitDisabled}
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
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Modal
      title="Create pipeline"
      onClose={onClose}
      maxWidth="max-w-4xl"
      tall
      scrollRef={scrollRef}
      subHeader={tabs}
      preFooter={jsonPreview}
      footer={footer}
      dirty={formDirty || ownFieldsDirty}
    >
      <ErrorAlert message={createError} className="mb-4" />
      <SuccessAlert message={createSuccess} className="mb-4" />


      {aiGated ? (
        <div className="space-y-2">
          <FeatureLock flag="ai_generation" />
          <p className="text-sm text-fg-muted">
            Or use the <span className="font-medium">Upload</span> or <span className="font-medium">Wizard</span> tabs to build a pipeline without AI.
          </p>
        </div>
      ) : activeTab === 'upload' ? (
        <UploadConfigTab ref={uploadRef} disabled={createLoading} />
      ) : activeTab === 'ai' ? (
        <GitUrlTab ref={aiRef} disabled={createLoading} initialUrl={initialGitUrl} autoGenerate={!!initialGitUrl} />
      ) : activeTab === 'prompt' ? (
        <PromptGenerateTab ref={promptRef} disabled={createLoading} />
      ) : (
        <FormBuilderTab
          ref={formRef}
          onDirtyChange={setFormDirty}
          disabled={createLoading}
          currentStep={currentStep}
          onStepChange={setCurrentStep}
          accessStatusSlot={accessSlot}
        />
      )}

      {/* The wizard renders the picker inside its own step; every other create
          mode submits directly, so it shows here — no tab creates with an
          unseen sharing rung. */}
      {!isWizardTab && !aiGated && accessSlot}

      {previewError && (
        <div className="mt-4 rounded-xl bg-warning-bg border border-warning-border p-3">
          <p className="text-sm text-warning-strong">{previewError}</p>
        </div>
      )}

      {complianceResult && (
        <div className={`mt-4 rounded-xl border p-4 ${complianceResult.passed ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : complianceResult.blocked ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800'}`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" />
              <span className="text-sm font-medium">Compliance check ({complianceResult.rulesEvaluated} rules evaluated)</span>
            </div>
            <button onClick={() => setComplianceResult(null)} className="text-xs text-fg-subtle hover:text-fg">Dismiss</button>
          </div>
          {complianceResult.passed && complianceResult.warnings.length === 0 && (
            <p className="text-sm text-success">All compliance checks passed.</p>
          )}
          {complianceResult.violations.map((v, i) => (
            <div key={`v-${i}`} className="flex items-start gap-2 mt-1">
              <Badge color="red">{v.severity === 'critical' ? 'Critical' : v.severity === 'error' ? 'Error' : 'Violation'}</Badge>
              <span className="text-sm text-fg-muted">{v.message}</span>
            </div>
          ))}
          {complianceResult.warnings.map((w, i) => (
            <div key={`w-${i}`} className="flex items-start gap-2 mt-1">
              <Badge color="yellow">Warn</Badge>
              <span className="text-sm text-fg-muted">{w.message}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
