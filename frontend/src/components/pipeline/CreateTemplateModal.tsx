// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutTemplate, Plus, Trash2, Wand2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { Pipeline, BuilderProps, TemplateInput } from '@/types';

/** A row in the inputs editor. `replaces` is the literal value in the source
 *  pipeline's props to swap for `{{ vars.<name> }}` — that's what turns a fixed
 *  config into a parameterized template (e.g. the repo URL → vars.repoUrl). */
interface EditableInput {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  default: string;
  options: string; // comma-separated
  replaces: string;
}

const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Find the first git repository URL anywhere in the props JSON, so we can offer
 *  to parameterize it. Matches https://…git-host…/… and scp-style git@host:… . */
function detectRepoUrl(props: BuilderProps | undefined | null): string | null {
  if (!props) return null;
  const json = JSON.stringify(props);
  const m = json.match(/https?:\/\/[^\s"']*(?:github|gitlab|bitbucket|dev\.azure|codecommit)[^\s"']*|git@[^\s"':]+:[^\s"']+/i);
  return m ? m[0].replace(/\.git$/, '') : null;
}

/** Swap each input's `replaces` literal with `{{ vars.<name> }}` throughout the
 *  props JSON, so instantiate can bake a user-supplied value back in. Pure. */
function parameterizeProps(props: BuilderProps, rows: EditableInput[]): BuilderProps {
  let json = JSON.stringify(props);
  for (const r of rows) {
    if (!r.replaces.trim()) continue;
    json = json.split(r.replaces).join(`{{ vars.${r.name} }}`);
  }
  return JSON.parse(json) as BuilderProps;
}

/** Build the API `inputs` from the editable rows (drops empty rows, parses options/defaults). */
function toTemplateInputs(rows: EditableInput[]): TemplateInput[] {
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

interface CreateTemplateModalProps {
  /** Pre-selected pipeline (the "Save as template" flow). When omitted, the modal
   *  shows a picker to choose which pipeline to base the template on. */
  pipeline?: Pipeline;
  /** `pipelines:publish` — required to publish a PUBLIC (shared) template. */
  canPublish: boolean;
  onClose: () => void;
  /** Called after a template is created (so the caller can refresh). */
  onCreated: () => void;
}

/**
 * Create a golden-path pipeline template from an existing pipeline's config.
 * A template = the pipeline's `props` (BuilderProps) + metadata; instantiating it
 * clones a governed starting point. Publishing scope is set by `accessModifier`
 * (private → your org catalog; public → shared with your org + teams, gated by
 * `pipelines:publish`). The shared SYSTEM catalog (all orgs) is a superadmin
 * action from the system org and isn't offered here.
 */
export function CreateTemplateModal({ pipeline, canPublish, onClose, onCreated }: CreateTemplateModalProps) {
  const preselected = !!pipeline;

  // Pipeline picker (New-template flow).
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelinesLoading, setPipelinesLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(pipeline?.id ?? '');
  // The pipeline whose `props` will back the template (fetched full to guarantee props).
  const [source, setSource] = useState<Pipeline | null>(pipeline ?? null);
  const [sourceLoading, setSourceLoading] = useState(false);

  const [name, setName] = useState(pipeline ? `${pipeline.pipelineName || pipeline.project}-template` : '');
  const [category, setCategory] = useState('general');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords] = useState('');
  const [access, setAccess] = useState<'public' | 'private'>('private');
  const [inputs, setInputs] = useState<EditableInput[]>([]);

  const addInput = () => setInputs((rows) => [...rows, { name: '', label: '', type: 'string', required: false, default: '', options: '', replaces: '' }]);
  const updateInput = (i: number, patch: Partial<EditableInput>) => setInputs((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeInput = (i: number) => setInputs((rows) => rows.filter((_, idx) => idx !== i));

  // One-click: declare a `repoUrl` input pre-filled with the detected source repo
  // URL as its `replaces` value, so the template can target ANY repo on instantiate.
  const parameterizeRepo = () => {
    const url = detectRepoUrl(source?.props);
    setInputs((rows) => (rows.some((r) => r.name === 'repoUrl')
      ? rows
      : [...rows, { name: 'repoUrl', label: 'Repository URL', type: 'string', required: true, default: '', options: '', replaces: url ?? '' }]));
  };

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Track mount state so the success-close timer never calls onClose() after the
  // parent has already torn the modal down.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Monotonic token guarding selectPipeline's async fetch: rapid re-selection
  // (or unmount) must not let an older response overwrite the current source.
  const selectGenRef = useRef(0);

  // Load the pipeline list for the picker (New-template flow only).
  const loadPipelines = useCallback(async () => {
    setPipelinesLoading(true);
    try {
      const res = await api.listPipelines({ limit: '200', includeTotal: 'false' });
      if (res.success && res.data) setPipelines(res.data.pipelines || []);
    } catch (err) {
      setError(formatError(err, 'Failed to load pipelines'));
    } finally {
      setPipelinesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!preselected) void loadPipelines();
  }, [preselected, loadPipelines]);

  // Preselected (Save-as-template): guarantee we have the full config (props),
  // even if the caller passed a list-trimmed pipeline row.
  useEffect(() => {
    if (preselected && pipeline && !pipeline.props) void selectPipeline(pipeline.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for the preselected pipeline.
  }, [preselected]);

  // Fetch the full pipeline (with props) when one is selected.
  const selectPipeline = async (id: string) => {
    const gen = ++selectGenRef.current;
    setSelectedId(id);
    setError(null);
    setSuccess(null);
    if (!id) { setSource(null); return; }
    setSourceLoading(true);
    try {
      const res = await api.getPipelineById(id);
      if (!mountedRef.current || selectGenRef.current !== gen) return; // superseded / unmounted
      const p = res.success ? res.data?.pipeline : undefined;
      if (!p) { setError('Could not load the selected pipeline.'); return; }
      setSource(p);
      if (!name.trim()) setName(`${p.pipelineName || p.project}-template`);
    } catch (err) {
      if (!mountedRef.current || selectGenRef.current !== gen) return;
      setError(formatError(err, 'Failed to load the selected pipeline'));
    } finally {
      if (mountedRef.current && selectGenRef.current === gen) setSourceLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) { setError('Template name is required.'); return; }
    if (!source?.props) { setError('Select a pipeline to base the template on.'); return; }
    for (const r of inputs) {
      if (r.name.trim() && !INPUT_NAME_RE.test(r.name.trim())) {
        setError(`Input name "${r.name}" must be a valid identifier (letters/digits/_, not starting with a digit).`); return;
      }
    }

    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      // Declared inputs → vars.<name>; swap each input's `replaces` literal in the
      // captured props for `{{ vars.<name> }}` so the template is parameterized
      // (e.g. the source repo URL becomes vars.repoUrl). A template with no inputs
      // instantiates as a clone of the source pipeline's config.
      const templateInputs = toTemplateInputs(inputs);
      const finalProps = parameterizeProps(source.props, inputs);
      const res = await api.createPipelineTemplate({
        name: name.trim(),
        description: description.trim() || undefined,
        keywords: keywords.trim() ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : undefined,
        category: category.trim() || 'general',
        accessModifier: access,
        props: finalProps,
        inputs: templateInputs,
      });
      if (res.success) {
        setSuccess(`Template "${name.trim()}" published to your ${access === 'public' ? 'shared catalog' : 'org catalog'}.`);
        onCreated();
        setTimeout(() => { if (mountedRef.current) onClose(); }, 1500);
      } else {
        setError(res.message || 'Failed to create template.');
      }
    } catch (err) {
      setError(formatError(err, 'Failed to create template'));
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <ModalFooter
      onCancel={onClose}
      onConfirm={handleCreate}
      loading={saving}
      confirmDisabled={!source?.props || !name.trim()}
      confirmLabel={<span className="inline-flex items-center gap-2"><LayoutTemplate className="w-4 h-4" />Create template</span>}
    />
  );

  return (
    <Modal title="Create template" onClose={onClose} maxWidth="max-w-lg" tall footer={footer}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Save a pipeline&apos;s configuration as a reusable golden-path starter. Teams instantiate it to spin up a governed pipeline in a few fields.
        </p>

        <ErrorAlert message={error} />
        <SuccessAlert message={success} />

        {/* Source pipeline */}
        {preselected ? (
          <FormField label="Source pipeline">
            <Input value={pipeline?.pipelineName || pipeline?.project || ''} disabled className="!bg-gray-50 dark:!bg-gray-800" />
          </FormField>
        ) : (
          <FormField label="Source pipeline" hint={pipelinesLoading ? 'Loading…' : 'the pipeline this template is based on'}>
            <Select value={selectedId} onChange={(e) => void selectPipeline(e.target.value)} disabled={saving || pipelinesLoading}>
              <option value="">Select a pipeline…</option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>{p.pipelineName || p.project}</option>
              ))}
            </Select>
          </FormField>
        )}

        {sourceLoading && (
          <p className="text-xs text-gray-400 flex items-center gap-1.5"><LoadingSpinner size="sm" /> Loading pipeline config…</p>
        )}

        <div className="grid grid-cols-2 gap-4">
          <FormField label="Template name">
            <Input value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="node-service" disabled={saving} />
          </FormField>
          <FormField label="Category">
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="backend" disabled={saving} />
          </FormField>
        </div>

        <FormField label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this starter sets up" disabled={saving} />
        </FormField>

        <FormField label="Keywords" hint="comma-separated (optional)">
          <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="golden-path, backend" disabled={saving} />
        </FormField>

        {/* Inputs (parameters) — declared vars users fill in on instantiate. */}
        <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Inputs (parameters)</span>
            <div className="flex items-center gap-3">
              <Button type="button" variant="link" onClick={parameterizeRepo} disabled={saving || !source?.props} className="text-xs">
                <Wand2 className="w-3.5 h-3.5 mr-1 inline" /> Parameterize repository
              </Button>
              <Button type="button" variant="secondary" size="xs" onClick={addInput} disabled={saving}>
                <Plus className="w-3.5 h-3.5 mr-1 inline" /> Add input
              </Button>
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            Each input becomes a <code>{'{{ vars.<name> }}'}</code> value. Set <strong>Replaces</strong> to the current value in this pipeline the input should substitute (e.g. the repo URL) — “Parameterize repository” auto-detects it.
          </p>
          {inputs.length === 0 ? (
            <p className="text-xs text-gray-400">No inputs — the template instantiates as a fixed clone. Add one to let users set the repo, branch, env, etc.</p>
          ) : (
            <div className="space-y-2">
              {inputs.map((row, i) => (
                <div key={i} className="rounded-lg border border-gray-200 dark:border-gray-700 p-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input value={row.name} onChange={(e) => updateInput(i, { name: e.target.value })} placeholder="name (repoUrl)" aria-label="Input name" disabled={saving} className="text-sm" />
                    <Input value={row.label} onChange={(e) => updateInput(i, { label: e.target.value })} placeholder="label (Repository URL)" aria-label="Input label" disabled={saving} className="text-sm" />
                    <Select value={row.type} onChange={(e) => updateInput(i, { type: e.target.value as EditableInput['type'] })} aria-label="Input type" disabled={saving} className="text-sm !w-28">
                      <option value="string">string</option>
                      <option value="number">number</option>
                      <option value="boolean">boolean</option>
                    </Select>
                    <Button type="button" variant="ghost" size="xs" onClick={() => removeInput(i)} aria-label="Remove input" disabled={saving} className="text-red-600 shrink-0">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input value={row.default} onChange={(e) => updateInput(i, { default: e.target.value })} placeholder="default (optional)" aria-label="Input default" disabled={saving} className="text-sm" />
                    <Input value={row.options} onChange={(e) => updateInput(i, { options: e.target.value })} placeholder="options: a,b,c (optional)" aria-label="Input options" disabled={saving} className="text-sm" />
                    <Input value={row.replaces} onChange={(e) => updateInput(i, { replaces: e.target.value })} placeholder="replaces value in config" aria-label="Value to replace" disabled={saving} className="text-sm" />
                    <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap shrink-0">
                      <Checkbox checked={row.required} onChange={(e) => updateInput(i, { required: e.target.checked })} disabled={saving} className="h-4 w-4" /> req
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <FormField
          label="Visibility"
          hint={canPublish
            ? 'Public shares it with your org and its teams. The shared SYSTEM catalog (all orgs) is a superadmin action from the system org.'
            : 'You need the pipelines:publish permission to publish a shared (public) template.'}
        >
          <Select value={access} onChange={(e) => setAccess(e.target.value as 'public' | 'private')} disabled={saving || !canPublish}>
            <option value="private">Private — your org catalog</option>
            {(canPublish || access === 'public') && <option value="public">Public — shared with your org &amp; teams</option>}
          </Select>
        </FormField>
      </div>
    </Modal>
  );
}
