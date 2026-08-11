// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { Pipeline } from '@/types';

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

    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const res = await api.createPipelineTemplate({
        name: name.trim(),
        description: description.trim() || undefined,
        keywords: keywords.trim() ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : undefined,
        category: category.trim() || 'general',
        accessModifier: access,
        props: source.props,
        // Parameterization (`{{ vars.* }}` inputs) is a follow-up; a template with
        // no inputs instantiates as a clone of the source pipeline's config.
        inputs: [],
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
