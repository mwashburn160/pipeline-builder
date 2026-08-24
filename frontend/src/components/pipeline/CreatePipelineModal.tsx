import { useState, useRef, useEffect } from 'react';
import { Plus, ChevronLeft, ChevronRight, ShieldCheck, Sparkles, Lock } from 'lucide-react';
import { useFeatures } from '@/hooks/useFeatures';
import { BuilderProps } from '@/types';
import type { ComplianceCheckResult } from '@/types/compliance';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
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
  const [activeTab, setActiveTab] = useState<'upload' | 'form' | 'ai' | 'prompt'>('ai');
  // AI generation is a paid feature. The two AI tabs (Git URL, From prompt) hit a
  // server-side `requireFeature('ai_generation')` gate — pre-gate them with an
  // upsell so an unentitled org sees why, instead of a 403 dead-end on submit.
  const aiEnabled = useFeatures().isEnabled('ai_generation');
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
  const promptRef = useRef<PromptGenerateTabRef>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to top when step changes
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [currentStep]);

  // Reset wizard/preview/compliance state whenever the modal (re)opens. The
  // component is rendered unconditionally and only gated by `if (!isOpen)`, so
  // without this a mid-flow close→reopen would restore stale step/preview/
  // compliance state while the child tabs remount empty (stepper desync).
  useEffect(() => {
    if (isOpen) {
      setActiveTab('ai');
      setCurrentStep(0);
      setShowPreview(false);
      setPreviewJson(null);
      setPreviewError(null);
      setComplianceResult(null);
    }
  }, [isOpen]);

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
      case 'prompt':
        desc = promptRef.current?.getDescription() ?? '';
        kw = promptRef.current?.getKeywords() ?? '';
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
          violations: [{ ruleId: 'error', ruleName: 'Compliance Check', field: '', operator: '', expectedValue: '', actualValue: '', severity: 'error', message }],
          warnings: [], exemptionsApplied: [],
        });
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

  // AI tab selected without the entitlement — show the upsell, block submit/preview
  // (they would 403 server-side), and skip the AI tab's generation calls.
  const aiGated = (activeTab === 'ai' || activeTab === 'prompt') && !aiEnabled;
  const isSubmitDisabled = createLoading || aiGated;
  const isWizardTab = activeTab === 'form';
  const isLastStep = currentStep === WIZARD_STEPS.length - 1;

  const accessSlot = (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
      <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Access</h3>
      <div className="flex items-center space-x-3">
        <Select
          value={createAccess}
          onChange={(e) => setCreateAccess(e.target.value as 'public' | 'private')}
          className="!w-auto"
          disabled={createLoading || !canCreatePublic}
        >
          <option value="private">Private</option>
          {canCreatePublic && <option value="public">Public</option>}
        </Select>
        {!canCreatePublic && (
          <span className="text-xs text-gray-500 dark:text-gray-400">Only admins can create public pipelines</span>
        )}
      </div>
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
      title="Create Pipeline"
      onClose={onClose}
      maxWidth="max-w-4xl"
      tall
      scrollRef={scrollRef}
      subHeader={tabs}
      preFooter={jsonPreview}
      footer={footer}
    >
      <ErrorAlert message={createError} className="mb-4" />
      <SuccessAlert message={createSuccess} className="mb-4" />


      {aiGated ? (
        <AiUpsell />
      ) : activeTab === 'upload' ? (
        <UploadConfigTab ref={uploadRef} disabled={createLoading} />
      ) : activeTab === 'ai' ? (
        <GitUrlTab ref={aiRef} disabled={createLoading} initialUrl={initialGitUrl} autoGenerate={!!initialGitUrl} />
      ) : activeTab === 'prompt' ? (
        <PromptGenerateTab ref={promptRef} disabled={createLoading} />
      ) : (
        <FormBuilderTab
          ref={formRef}
          disabled={createLoading}
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

/**
 * Upsell shown in place of the AI generation tabs when the org lacks the
 * `ai_generation` entitlement — mirrors the DORA/advanced_reporting gate so the
 * user sees why the feature is unavailable instead of a 403 on submit. The other
 * create modes (Upload, Wizard) stay available on their own tabs.
 */
function AiUpsell() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
      <Lock className="w-5 h-5 shrink-0 mt-0.5" />
      <div>
        <div className="flex items-center gap-1.5 font-medium">
          <Sparkles className="w-4 h-4" /> AI generation isn&apos;t included in your current plan
        </div>
        <p className="mt-1 text-amber-800 dark:text-amber-300">
          Generating a pipeline from a Git URL or a prompt needs the AI Generation feature, available on the Pro,
          Team, and Enterprise tiers (or as an add-on). Upgrade your plan to unlock it — or use the
          <span className="font-medium"> Upload</span> or <span className="font-medium">Wizard</span> tabs to build a
          pipeline without AI.
        </p>
      </div>
    </div>
  );
}
