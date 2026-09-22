import { useState, useRef, useEffect, useCallback } from 'react';
import { formatDateTime } from '@/lib/format';
import { useAsyncCallback } from '@/hooks/useAsync';
import { useEntityFetch } from '@/hooks/useEntityFetch';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import { ReadonlyField } from '@/components/ui/ReadonlyField';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
import type { PipelineSummary } from '@/lib/api/domains/pipelines';
import { Pipeline, BuilderProps, Visibility } from '@/types';
import FormBuilderTab, { FormBuilderTabRef } from './FormBuilderTab';
import { JsonPreviewPanel } from './JsonPreviewPanel';
import { useBuilderWizard } from '@/hooks/useBuilderWizard';
import CollapsibleSection from './editors/CollapsibleSection';
import { WIZARD_STEPS } from '@/lib/wizard-validation';
import { formatError, formatEnvelopeError } from '@/lib/constants';
import { useIsDirty } from '@/hooks/useIsDirty';
import { VisibilitySelect, visibilityHint } from '@/components/ui/VisibilitySelect';
import { CatalogOwnerFields, type CatalogOwner } from '@/components/ui/CatalogOwnerFields';
import { useAuth } from '@/hooks/useAuth';
import { isOrgAdmin, isSystemAdmin } from '@/lib/auth-helpers';
import { useAutoCloseTimer } from '@/hooks/useAutoCloseTimer';

/** Props for {@link EditPipelineModal}. */
interface EditPipelineModalProps {
  /** The row to edit — a list summary is enough (the list omits `props`); the
   *  full record, `props` included, is fetched by id on mount. */
  pipeline: PipelineSummary;
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
  // Catalog owner (person or team). Reassigning it is admin-only server-side, so
  // a member sees the control read-only rather than having a save silently drop it.
  // (the list row omits the owner columns — seeded from the full record below)
  const [owner, setOwner] = useState<CatalogOwner>({});
  const { user } = useAuth();
  const canAssignOwner = isOrgAdmin(user) || isSystemAdmin(user);
  const { execute: saveAsync, loading, error, clearError } = useAsyncCallback(
    (data: Parameters<typeof api.updatePipeline>[1]) => api.updatePipeline(pipeline.id, data),
  );
  const [success, setSuccess] = useState<string | null>(null);

  const formRef = useRef<FormBuilderTabRef>(null);
  const { currentStep, setCurrentStep, next: handleNext, prev: handlePrevious, reset: resetWizard, scrollRef, preview } = useBuilderWizard(formRef);
  // The builder owns the bulk of the form, so it reports its own edits; the
  // fields this modal owns are compared here. Together they gate the discard prompt.
  const [formDirty, setFormDirty] = useState(false);
  const ownFieldsDirty = useIsDirty({ isActive, isDefault, visibility, ownerId: owner.ownerId, ownerType: owner.ownerType });

  const autoClose = useAutoCloseTimer();

  // Fetch full pipeline data by ID to ensure description/keywords are populated.
  // useEntityFetch only re-fetches when `id` changes, so stale re-mounts during
  // the 1.5s success-close window won't overwrite user edits.
  // No list-row fallback: the row lacks `props`, and seeding the builder with
  // an empty config would let a save wipe the pipeline's real one.
  const fetchPipeline = useCallback(async (id: string): Promise<Pipeline> => {
    const response = await api.getPipelineById(id);
    if (!response.data?.pipeline) throw new Error(formatEnvelopeError(response, 'Failed to load pipeline'));
    return response.data.pipeline;
  }, []);
  const { entity: fullPipeline, fetching, error: fetchError } = useEntityFetch<Pipeline>(pipeline.id, fetchPipeline);

  // Reset wizard/preview state and seed editable fields when the fetched
  // pipeline changes (parent may keep us mounted within the close window).
  useEffect(() => {
    resetWizard();
    setSuccess(null);
  }, [pipeline.id, resetWizard]);

  useEffect(() => {
    if (!fullPipeline) return;
    setIsActive(fullPipeline.isActive);
    setIsDefault(fullPipeline.isDefault);
    setVisibility(fullPipeline.visibility);
    setOwner({ ownerId: fullPipeline.ownerId, ownerType: fullPipeline.ownerType });
  }, [fullPipeline]);

  // The full record (fetched by id); null until it lands.
  const p = fullPipeline;
  const loadingRecord = fetching || !p;

  const resolveProps = (): BuilderProps | null => {
    return formRef.current?.getProps() ?? null;
  };

  const handlePreview = () => {
    clearError();
    preview.show(formRef.current?.getPropsPreview() ?? null);
  };

  const handleSave = async () => {
    clearError();
    setSuccess(null);

    const parsedProps = resolveProps();
    if (!parsedProps) return;

    // Get description/keywords from form state
    const desc = formRef.current?.getDescription() ?? p?.description ?? '';
    const kw = formRef.current?.getKeywords() ?? p?.keywords?.join(', ') ?? '';

    const response = await saveAsync({
      pipelineName: parsedProps.pipelineName,
      description: desc,
      keywords: kw.split(',').map(k => k.trim()).filter(k => k),
      props: parsedProps,
      isActive,
      isDefault,
      visibility,
      // Owner is admin-only server-side and non-nullable in the schema, so only
      // send it when this viewer may set it AND it resolves to a real id.
      ...(canAssignOwner && owner.ownerId && owner.ownerType
        ? { ownerId: owner.ownerId, ownerType: owner.ownerType }
        : {}),
    });

    if (response?.success) {
      setSuccess('Pipeline updated successfully!');
      // Every cached pipeline list (palette, home, deployments drift) is stale now.
      invalidate.pipelines();
      onSaved();
      autoClose.schedule(onClose, 1500);
    }
  };

  const isLastStep = currentStep === WIZARD_STEPS.length - 1;

  const accessStatusSlot = (
    <div className="mt-4 pt-4 border-t border-default">
      <h3 className="text-sm font-medium text-fg-muted mb-3">Access & Status</h3>
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
          <p className="text-xs text-fg-subtle mt-1">{visibilityHint(canPublish, 'pipelines:publish')}</p>
        </div>
        {/* Owner + team access. Renders only for an org that actually parents
            teams (or a pipeline already team-owned) — see CatalogOwnerFields
            for why this is ownership, not a cross-org move. */}
        <CatalogOwnerFields
          value={owner}
          onChange={setOwner}
          visibility={visibility}
          canAssign={canAssignOwner}
          personOwnerId={(p?.ownerType === 'user' && p?.ownerId) || p?.createdBy || ''}
          onShareWithTeams={canPublish ? () => setVisibility('public') : undefined}
          entityNoun="pipelines"
          publishPermission="pipelines:publish"
          idPrefix="editPipeline"
          disabled={loading}
        />
      </div>
      <div className="flex items-center space-x-6">
        <div className="flex items-center">
          <Checkbox id="editPipelineIsActive" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 text-brand focus:ring-[color:var(--pb-ring)]" disabled={loading} />
          <label htmlFor="editPipelineIsActive" className="ml-2 block text-sm text-fg-muted">Active</label>
        </div>
        <div className="flex items-center">
          <Checkbox id="editPipelineIsDefault" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="h-4 w-4 text-brand focus:ring-[color:var(--pb-ring)]" disabled={loading} />
          <label htmlFor="editPipelineIsDefault" className="ml-2 block text-sm text-fg-muted">Default</label>
        </div>
      </div>
    </div>
  );

  const jsonPreview = <JsonPreviewPanel preview={preview} edit={{ subject: 'pipeline', disabled: loading }} />;

  const footer = (
    <div className="flex items-center justify-between">
      <Button
        variant="secondary"
        onClick={handlePreview}
        disabled={loading || loadingRecord}
      >
        {preview.open ? 'Refresh JSON' : 'Edit JSON'}
      </Button>

      <div className="flex items-center space-x-3">
        <Button variant="secondary" onClick={onClose} disabled={loading}>
          Cancel
        </Button>

        {currentStep > 0 && (
          <Button variant="secondary" onClick={handlePrevious} disabled={loading || loadingRecord}>
            <ChevronLeft className="w-4 h-4 mr-1" />
            Previous
          </Button>
        )}

        {!isLastStep ? (
          <Button onClick={handleNext} disabled={loading || loadingRecord}>
            Next
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        ) : (
          <Button onClick={handleSave} disabled={loading || loadingRecord}>
            {loading ? (<><LoadingSpinner size="sm" className="mr-2" />Saving...</>) : 'Save Changes'}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Modal
      title="Edit pipeline"
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

      {!p && fetchError ? (
        <ErrorAlert message={formatError(fetchError, 'Failed to load pipeline')} />
      ) : loadingRecord || !p ? (
        <div className="flex justify-center py-12"><LoadingSpinner size="lg" /></div>
      ) : (
        <>
          {/* System Information (collapsible, read-only) */}
          <div className="mb-4">
            <CollapsibleSection title="System information" hasContent={true}>
              <div className="mt-3 grid grid-cols-2 gap-4">
                <ReadonlyField label="ID" value={p.id} valueClassName="font-mono" />
                <ReadonlyField label="Org ID" value={p.orgId} />
                <ReadonlyField label="Project" value={p.project} />
                <ReadonlyField label="Organization" value={p.organization} />
                <ReadonlyField label="Created by" value={p.createdBy} />
                <ReadonlyField label="Created at" value={formatDateTime(p.createdAt)} />
                <ReadonlyField label="Updated by" value={p.updatedBy} />
                <ReadonlyField label="Updated at" value={formatDateTime(p.updatedAt)} />
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
