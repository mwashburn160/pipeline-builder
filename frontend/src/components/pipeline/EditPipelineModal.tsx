import { useState, useRef, useEffect, useCallback } from 'react';
import { formatDateTime } from '@/lib/format';
import { useAsyncCallback } from '@/hooks/useAsync';
import { useEntityFetch } from '@/hooks/useEntityFetch';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import { ReadonlyField } from '@/components/ui/ReadonlyField';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import api from '@/lib/api';
import { Pipeline, BuilderProps, Visibility } from '@/types';
import FormBuilderTab, { FormBuilderTabRef } from './FormBuilderTab';
import CollapsibleSection from './editors/CollapsibleSection';
import { WIZARD_STEPS } from '@/lib/wizard-validation';
import { formatError, formatJSON } from '@/lib/constants';
import { useIsDirty } from '@/hooks/useIsDirty';
import { VisibilitySelect, visibilityHint } from '@/components/ui/VisibilitySelect';

/** Props for {@link EditPipelineModal}. */
interface EditPipelineModalProps {
  /** The pipeline record to edit (may be partial; full data is fetched on mount). */
  pipeline: Pipeline;
  /** `pipelines:publish` — required for the `public` rung of the visibility ladder. */
  canPublish: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback invoked after a successful save so the parent can refresh its list. */
  onSaved: () => void;
}

/**
 * Modal for editing an existing pipeline configuration.
 *
 * Fetches the full pipeline record by ID on mount, then renders a wizard-mode
 * FormBuilderTab pre-populated with the existing configuration. Includes a
 * read-only System Information section and controls for access modifier,
 * active/default status.
 */
export default function EditPipelineModal({ pipeline, canPublish, onClose, onSaved }: EditPipelineModalProps) {
  const [isActive, setIsActive] = useState(pipeline.isActive);
  const [isDefault, setIsDefault] = useState(pipeline.isDefault);
  const [visibility, setVisibility] = useState<Visibility>(pipeline.visibility);
  const { execute: saveAsync, loading, error, clearError } = useAsyncCallback(
    (data: Parameters<typeof api.updatePipeline>[1]) => api.updatePipeline(pipeline.id, data),
  );
  const [success, setSuccess] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewJson, setPreviewJson] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [jsonApplied, setJsonApplied] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  const formRef = useRef<FormBuilderTabRef>(null);
  // The builder owns the bulk of the form, so it reports its own edits; the
  // fields this modal owns are compared here. Together they gate the discard prompt.
  const [formDirty, setFormDirty] = useState(false);
  const ownFieldsDirty = useIsDirty({ isActive, isDefault, visibility });
  const scrollRef = useRef<HTMLDivElement>(null);

  // Track mount state so the success-close timer never calls onClose() after the
  // parent has already torn the modal down (e.g. list refresh unmounts us).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Fetch full pipeline data by ID to ensure description/keywords are populated.
  // useEntityFetch only re-fetches when `id` changes, so stale re-mounts during
  // the 1.5s success-close window won't overwrite user edits.
  const fetchPipeline = useCallback(async (id: string): Promise<Pipeline> => {
    const response = await api.getPipelineById(id);
    return response.data?.pipeline ?? pipeline;
  }, [pipeline]);
  const { entity: fullPipeline, fetching } = useEntityFetch<Pipeline>(pipeline.id, fetchPipeline, pipeline);

  // Reset wizard/preview state and seed editable fields when the fetched
  // pipeline changes (parent may keep us mounted within the close window).
  useEffect(() => {
    setCurrentStep(0);
    setShowPreview(false);
    setPreviewJson(null);
    setSuccess(null);
  }, [pipeline.id]);

  useEffect(() => {
    if (!fullPipeline) return;
    setIsActive(fullPipeline.isActive);
    setIsDefault(fullPipeline.isDefault);
    setVisibility(fullPipeline.visibility);
  }, [fullPipeline]);

  // Scroll to top when step changes
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [currentStep]);

  // Resolved pipeline data (fetched by ID, or fallback to list data)
  const p = fullPipeline ?? pipeline;

  const resolveProps = (): BuilderProps | null => {
    return formRef.current?.getProps() ?? null;
  };

  const handlePreview = () => {
    clearError();
    setJsonError(null);
    setJsonApplied(false);
    const props = formRef.current?.getPropsPreview() ?? null;
    if (props) {
      setPreviewJson(formatJSON(props));
      setShowPreview(true);
    }
  };

  // Apply hand-edited JSON back into the form (raw-JSON escape hatch). Parses the
  // textarea, feeds it through the same props→form conversion the loader uses, then
  // re-renders the JSON from the normalized form so the two stay in sync.
  const handleApplyJson = () => {
    setJsonError(null);
    setJsonApplied(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(previewJson ?? '');
    } catch (err) {
      setJsonError(`Invalid JSON: ${formatError(err)}`);
      return;
    }
    if (!formRef.current) {
      setJsonError('Form not ready');
      return;
    }
    // loadFromProps returns an error string on failure, or null on success — so check
    // the ref separately above (a successful null must NOT be read as "not ready").
    const err = formRef.current.loadFromProps(parsed);
    if (err) {
      setJsonError(err);
      return;
    }
    // Reflect the normalized form back into the editor.
    const normalized = formRef.current?.getPropsPreview() ?? null;
    if (normalized) setPreviewJson(formatJSON(normalized));
    setJsonApplied(true);
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
    clearError();
    setSuccess(null);

    const parsedProps = resolveProps();
    if (!parsedProps) return;

    // Get description/keywords from form state
    const desc = formRef.current?.getDescription() ?? p.description ?? '';
    const kw = formRef.current?.getKeywords() ?? p.keywords?.join(', ') ?? '';

    const response = await saveAsync({
      pipelineName: parsedProps.pipelineName,
      description: desc,
      keywords: kw.split(',').map(k => k.trim()).filter(k => k),
      props: parsedProps,
      isActive,
      isDefault,
      visibility,
    });

    if (response?.success) {
      setSuccess('Pipeline updated successfully!');
      onSaved();
      setTimeout(() => { if (mountedRef.current) onClose(); }, 1500);
    }
  };

  const isLastStep = currentStep === WIZARD_STEPS.length - 1;

  const accessStatusSlot = (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
      <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Access & Status</h3>
      <div className="grid grid-cols-2 gap-4 mb-3">
        <div>
          <label className="label" htmlFor="editPipelineVisibility">Visibility</label>
          <VisibilitySelect
            id="editPipelineVisibility"
            value={visibility}
            onChange={setVisibility}
            canPublish={canPublish}
            disabled={loading}
          />
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{visibilityHint(canPublish, 'pipelines:publish')}</p>
        </div>
      </div>
      <div className="flex items-center space-x-6">
        <div className="flex items-center">
          <Checkbox id="editPipelineIsActive" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 text-blue-600 focus:ring-blue-500" disabled={loading} />
          <label htmlFor="editPipelineIsActive" className="ml-2 block text-sm text-gray-700 dark:text-gray-300">Active</label>
        </div>
        <div className="flex items-center">
          <Checkbox id="editPipelineIsDefault" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="h-4 w-4 text-blue-600 focus:ring-blue-500" disabled={loading} />
          <label htmlFor="editPipelineIsDefault" className="ml-2 block text-sm text-gray-700 dark:text-gray-300">Default</label>
        </div>
      </div>
    </div>
  );

  const jsonPreview = showPreview && previewJson !== null ? (
    <div className="border-t border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between px-6 py-2 bg-gray-100 dark:bg-gray-800">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Edit JSON <span className="font-normal text-gray-400">— edit the pipeline `props` directly, then Apply</span></span>
        <div className="flex items-center gap-3">
          <button
            onClick={handleApplyJson}
            disabled={loading}
            className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 text-sm font-medium transition-colors disabled:opacity-50"
          >
            Apply to form
          </button>
          <button
            onClick={() => setShowPreview(false)}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm transition-colors"
          >
            Close
          </button>
        </div>
      </div>
      <div className="px-6 py-3 bg-gray-50 dark:bg-gray-900">
        <Textarea
          value={previewJson}
          onChange={(e) => { setPreviewJson(e.target.value); setJsonError(null); setJsonApplied(false); }}
          rows={14}
          spellCheck={false}
          className="font-mono text-xs w-full"
          disabled={loading}
        />
        {jsonError && <p className="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">{jsonError}</p>}
        {jsonApplied && !jsonError && <p className="mt-2 text-xs text-green-600 dark:text-green-400">Applied to the form. Review the wizard, then Save.</p>}
      </div>
    </div>
  ) : undefined;

  const footer = (
    <div className="flex items-center justify-between">
      <Button
        variant="secondary"
        onClick={handlePreview}
        disabled={loading || fetching}
      >
        {showPreview ? 'Refresh JSON' : 'Edit JSON'}
      </Button>

      <div className="flex items-center space-x-3">
        <Button variant="secondary" onClick={onClose} disabled={loading}>
          Cancel
        </Button>

        {currentStep > 0 && (
          <Button variant="secondary" onClick={handlePrevious} disabled={loading || fetching}>
            <ChevronLeft className="w-4 h-4 mr-1" />
            Previous
          </Button>
        )}

        {!isLastStep ? (
          <Button onClick={handleNext} disabled={loading || fetching}>
            Next
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        ) : (
          <Button onClick={handleSave} disabled={loading || fetching}>
            {loading ? (<><LoadingSpinner size="sm" className="mr-2" />Saving...</>) : 'Save Changes'}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Modal
      title="Edit Pipeline"
      onClose={onClose}
      maxWidth="max-w-4xl"
      tall
      scrollRef={scrollRef}
      preFooter={jsonPreview}
      footer={footer}
      dirty={formDirty || ownFieldsDirty}
    >
      <ErrorAlert message={error} className="mb-4" />
      <SuccessAlert message={success} className="mb-4" />


      {fetching ? (
        <div className="flex justify-center py-12"><LoadingSpinner size="lg" /></div>
      ) : (
        <>
          {/* System Information (collapsible, read-only) */}
          <div className="mb-4">
            <CollapsibleSection title="System Information" hasContent={true}>
              <div className="mt-3 grid grid-cols-2 gap-4">
                <ReadonlyField label="ID" value={p.id} valueClassName="font-mono" />
                <ReadonlyField label="Org ID" value={p.orgId} />
                <ReadonlyField label="Project" value={p.project} />
                <ReadonlyField label="Organization" value={p.organization} />
                <ReadonlyField label="Created By" value={p.createdBy} />
                <ReadonlyField label="Created At" value={formatDateTime(p.createdAt)} />
                <ReadonlyField label="Updated By" value={p.updatedBy} />
                <ReadonlyField label="Updated At" value={formatDateTime(p.updatedAt)} />
              </div>
            </CollapsibleSection>
          </div>

          <FormBuilderTab
            ref={formRef}
            onDirtyChange={setFormDirty}
            disabled={loading}
            initialProps={p.props}
            initialDescription={p.description || ''}
            initialKeywords={p.keywords?.join(', ') || ''}
            currentStep={currentStep}
            onStepChange={setCurrentStep}
            accessStatusSlot={accessStatusSlot}
          />
        </>
      )}
    </Modal>
  );
}
