// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAsyncCallback } from '@/hooks/useAsync';
import { useEntityFetch } from '@/hooks/useEntityFetch';
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import api from '@/lib/api';
import { PipelineTemplate, BuilderProps, TemplateInput } from '@/types';
import FormBuilderTab, { FormBuilderTabRef } from './FormBuilderTab';
import CollapsibleSection from './editors/CollapsibleSection';
import { WIZARD_STEPS } from '@/lib/wizard-validation';
import { formatJSON } from '@/lib/constants';

/** A row in the inputs editor — the editable counterpart of a {@link TemplateInput}. */
interface EditableInput {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  default: string;
  options: string; // comma-separated
}

const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Seed editor rows from a template's declared inputs. */
function toEditableInputs(inputs: TemplateInput[] | undefined): EditableInput[] {
  return (inputs || []).map((inp) => ({
    name: inp.name,
    label: inp.label ?? '',
    type: inp.type,
    required: Boolean(inp.required),
    default: inp.default !== undefined ? String(inp.default) : '',
    options: (inp.options ?? []).join(', '),
  }));
}

/** Build the API `inputs` from the editable rows (drops empty rows, parses options/defaults). */
function buildInputs(rows: EditableInput[]): TemplateInput[] {
  return rows
    .filter((r) => r.name.trim())
    .map((r) => {
      const opts = r.options.split(',').map((o) => o.trim()).filter(Boolean);
      const inp: TemplateInput = { name: r.name.trim(), type: r.type };
      if (r.label.trim()) (inp as { label?: string }).label = r.label.trim();
      if (r.required) (inp as { required?: boolean }).required = true;
      if (opts.length) (inp as { options?: string[] }).options = opts;
      if (r.default.trim()) {
        const d = r.type === 'number' ? Number(r.default) : r.type === 'boolean' ? r.default === 'true' : r.default;
        (inp as { default?: unknown }).default = d;
      }
      return inp;
    });
}

/** Props for {@link EditTemplateModal}. */
interface EditTemplateModalProps {
  /** The template record to edit (may be partial; full data is fetched on mount). */
  template: PipelineTemplate;
  /** `pipelines:publish` — required to change access to/from PUBLIC. */
  canPublish: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback invoked after a successful save so the parent can refresh its list. */
  onSaved: () => void;
}

/**
 * Modal for editing an existing pipeline template.
 *
 * Fetches the full template record by ID on mount, then renders a wizard-mode
 * FormBuilderTab pre-populated with the template's props (where vars/metadata/
 * stages are edited). Additional template-only fields (name, category, access,
 * and the declared inputs) are edited alongside the config on the first step.
 */
export default function EditTemplateModal({ template, canPublish, onClose, onSaved }: EditTemplateModalProps) {
  const [name, setName] = useState(template.name);
  const [category, setCategory] = useState(template.category);
  const [accessModifier, setAccessModifier] = useState<'public' | 'private'>(
    template.accessModifier === 'public' ? 'public' : 'private',
  );
  const [inputs, setInputs] = useState<EditableInput[]>(toEditableInputs(template.inputs));

  const { execute: saveAsync, loading, error, clearError } = useAsyncCallback(
    (data: Parameters<typeof api.updatePipelineTemplate>[1]) => api.updatePipelineTemplate(template.id, data),
  );
  const [success, setSuccess] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewJson, setPreviewJson] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState(0);

  const formRef = useRef<FormBuilderTabRef>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Track mount state so the success-close timer never calls onClose() after the
  // parent has already torn the modal down (e.g. list refresh unmounts us).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Fetch full template data by ID to ensure props/inputs are populated.
  // useEntityFetch only re-fetches when `id` changes, so stale re-mounts during
  // the 1.5s success-close window won't overwrite user edits.
  const fetchTemplate = useCallback(async (id: string): Promise<PipelineTemplate> => {
    const response = await api.getPipelineTemplate(id);
    return response.data?.template ?? template;
  }, [template]);
  const { entity: fullTemplate, fetching } = useEntityFetch<PipelineTemplate>(template.id, fetchTemplate, template);

  // Reset wizard/preview state when the fetched template changes (parent may keep
  // us mounted within the close window).
  useEffect(() => {
    setCurrentStep(0);
    setShowPreview(false);
    setPreviewJson(null);
    setSuccess(null);
  }, [template.id]);

  // Seed editable fields from the fetched (full) record.
  useEffect(() => {
    if (!fullTemplate) return;
    setName(fullTemplate.name);
    setCategory(fullTemplate.category);
    setAccessModifier(fullTemplate.accessModifier === 'public' ? 'public' : 'private');
    setInputs(toEditableInputs(fullTemplate.inputs));
  }, [fullTemplate]);

  // Scroll to top when step changes.
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [currentStep]);

  // Resolved template data (fetched by ID, or fallback to list data).
  const t = fullTemplate ?? template;

  const addInput = () => setInputs((rows) => [...rows, { name: '', label: '', type: 'string', required: false, default: '', options: '' }]);
  const updateInput = (i: number, patch: Partial<EditableInput>) => setInputs((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeInput = (i: number) => setInputs((rows) => rows.filter((_, idx) => idx !== i));

  const resolveProps = (): BuilderProps | null => {
    return formRef.current?.getProps() ?? null;
  };

  const handlePreview = () => {
    clearError();
    const props = formRef.current?.getPropsPreview() ?? null;
    if (props) {
      setPreviewJson(formatJSON(props));
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
    clearError();
    setSuccess(null);

    if (!name.trim()) { formRef.current?.goToStep(0); return; }
    for (const r of inputs) {
      if (r.name.trim() && !INPUT_NAME_RE.test(r.name.trim())) {
        formRef.current?.goToStep(0);
        return;
      }
    }

    const parsedProps = resolveProps();
    if (!parsedProps) return;

    // Get description/keywords from form state.
    const desc = formRef.current?.getDescription() ?? t.description ?? '';
    const kw = formRef.current?.getKeywords() ?? t.keywords?.join(', ') ?? '';

    const response = await saveAsync({
      name: name.trim(),
      description: desc,
      keywords: kw.split(',').map((k) => k.trim()).filter((k) => k),
      category: category.trim() || 'general',
      accessModifier,
      props: parsedProps,
      inputs: buildInputs(inputs),
    });

    if (response?.success) {
      setSuccess('Template updated successfully!');
      onSaved();
      setTimeout(() => { if (mountedRef.current) onClose(); }, 1500);
    }
  };

  const isLastStep = currentStep === WIZARD_STEPS.length - 1;

  // Template-only fields (name / category / access / inputs), injected into the
  // FormBuilderTab's first step alongside the pipeline config.
  const templateMetaSlot = (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 space-y-4">
      <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Template details</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Template name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="node-service" disabled={loading} />
        </div>
        <div>
          <label className="label">Category</label>
          <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="backend" disabled={loading} />
        </div>
      </div>

      <div>
        <label className="label">Access Modifier</label>
        <Select
          value={accessModifier}
          onChange={(e) => setAccessModifier(e.target.value as 'public' | 'private')}
          className="disabled:bg-gray-100 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
          disabled={loading || !canPublish}
        >
          <option value="private">Private — your org catalog</option>
          {(canPublish || accessModifier === 'public') && <option value="public">Public — shared with your org &amp; teams</option>}
        </Select>
        {!canPublish && (
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">You need the pipelines:publish permission to change the shared (public) access level</p>
        )}
      </div>

      {/* Inputs (parameters) — declared vars users fill in on instantiate. */}
      <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Inputs (parameters)</span>
          <Button type="button" variant="secondary" size="xs" onClick={addInput} disabled={loading}>
            <Plus className="w-3.5 h-3.5 mr-1 inline" /> Add input
          </Button>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          Each input maps to a <code>{'{{ vars.<name> }}'}</code> value referenced in the template body above.
        </p>
        {inputs.length === 0 ? (
          <p className="text-xs text-gray-400">No inputs — the template instantiates as a fixed clone. Add one to let users set the repo, branch, env, etc.</p>
        ) : (
          <div className="space-y-2">
            {inputs.map((row, i) => (
              <div key={i} className="rounded-lg border border-gray-200 dark:border-gray-700 p-2 space-y-2">
                <div className="flex items-center gap-2">
                  <Input value={row.name} onChange={(e) => updateInput(i, { name: e.target.value })} placeholder="name (repoUrl)" aria-label="Input name" disabled={loading} className="text-sm" />
                  <Input value={row.label} onChange={(e) => updateInput(i, { label: e.target.value })} placeholder="label (Repository URL)" aria-label="Input label" disabled={loading} className="text-sm" />
                  <Select value={row.type} onChange={(e) => updateInput(i, { type: e.target.value as EditableInput['type'] })} aria-label="Input type" disabled={loading} className="text-sm !w-28">
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                  </Select>
                  <Button type="button" variant="ghost" size="xs" onClick={() => removeInput(i)} aria-label="Remove input" disabled={loading} className="text-red-600 shrink-0">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Input value={row.default} onChange={(e) => updateInput(i, { default: e.target.value })} placeholder="default (optional)" aria-label="Input default" disabled={loading} className="text-sm" />
                  <Input value={row.options} onChange={(e) => updateInput(i, { options: e.target.value })} placeholder="options: a,b,c (optional)" aria-label="Input options" disabled={loading} className="text-sm" />
                  <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap shrink-0">
                    <Checkbox checked={row.required} onChange={(e) => updateInput(i, { required: e.target.checked })} disabled={loading} className="h-4 w-4" /> req
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
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
      <Button
        variant="secondary"
        onClick={handlePreview}
        disabled={loading || fetching}
      >
        Preview JSON
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
      title="Edit Template"
      onClose={onClose}
      maxWidth="max-w-4xl"
      tall
      scrollRef={scrollRef}
      preFooter={jsonPreview}
      footer={footer}
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
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">ID</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 font-mono bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{t.id}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Org ID</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{t.orgId}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Created By</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{t.createdBy}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Created At</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{new Date(t.createdAt).toLocaleString()}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Updated By</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{t.updatedBy}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Updated At</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{new Date(t.updatedAt).toLocaleString()}</p>
                </div>
              </div>
            </CollapsibleSection>
          </div>

          <FormBuilderTab
            ref={formRef}
            disabled={loading}
            initialProps={t.props}
            initialDescription={t.description || ''}
            initialKeywords={t.keywords?.join(', ') || ''}
            currentStep={currentStep}
            onStepChange={setCurrentStep}
            accessStatusSlot={templateMetaSlot}
          />
        </>
      )}
    </Modal>
  );
}
