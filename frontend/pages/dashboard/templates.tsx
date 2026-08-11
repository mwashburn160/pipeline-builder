// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/router';
import { LayoutTemplate, RefreshCw, Sparkles } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useToast } from '@/components/ui/Toast';
import { formatError } from '@/lib/constants';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { ResourceList } from '@/components/ui/ResourceList';
import { CreateTemplateModal } from '@/components/pipeline/CreateTemplateModal';
import api from '@/lib/api';
import type { PipelineTemplate, TemplateInput } from '@/types';

/** Coerce a form value (always a string from inputs) to its declared type.
 *  Empty values are filtered out by the caller before this runs. */
function coerceValue(type: TemplateInput['type'], raw: string | boolean): string | number | boolean {
  if (type === 'boolean') return typeof raw === 'boolean' ? raw : raw === 'true';
  if (type === 'number') return Number(raw);
  return String(raw);
}

/**
 * Golden-path templates gallery. Browse the shared catalog, fill a template's
 * declared inputs, and instantiate it into a real pipeline (the instantiate
 * endpoint renders the props; creation goes through the normal pipeline-create
 * path, so compliance + quota still apply).
 */
export default function TemplatesPage() {
  const { user, isReady, can } = useAuthGuard();
  const toast = useToast();
  const router = useRouter();
  const canWrite = can('pipelines:write');
  const canPublish = can('pipelines:publish');
  const [showCreate, setShowCreate] = useState(false);

  const [templates, setTemplates] = useState<PipelineTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Instantiate modal state
  const [selected, setSelected] = useState<PipelineTemplate | null>(null);
  const [project, setProject] = useState('');
  const [pipelineName, setPipelineName] = useState('');
  const [inputValues, setInputValues] = useState<Record<string, string | boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPipelineTemplates({ limit: '200' });
      if (res.success && res.data) setTemplates(res.data.templates || []);
      else setError('Failed to load templates');
    } catch (err) {
      setError(formatError(err, 'Failed to load templates'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isReady) void fetchAll();
  }, [isReady, fetchAll]);

  const openInstantiate = (t: PipelineTemplate) => {
    setSelected(t);
    setProject('');
    setPipelineName('');
    // Seed input values from declared defaults.
    const seed: Record<string, string | boolean> = {};
    for (const inp of t.inputs || []) {
      if (inp.default !== undefined) seed[inp.name] = inp.type === 'boolean' ? Boolean(inp.default) : String(inp.default);
      else if (inp.type === 'boolean') seed[inp.name] = false;
      else seed[inp.name] = '';
    }
    setInputValues(seed);
  };

  const organization = user?.organizationName || user?.organizationId || '';

  const handleCreate = async () => {
    if (!selected) return;
    if (!project.trim()) { toast.error('Project is required'); return; }
    // Client-side input validation (server re-validates).
    for (const inp of selected.inputs || []) {
      const v = inputValues[inp.name];
      if (inp.required && inp.default === undefined && (v === undefined || v === '')) {
        toast.error(`Input "${inp.label || inp.name}" is required`); return;
      }
      if (inp.type === 'number' && v !== undefined && v !== '' && !Number.isFinite(Number(v))) {
        toast.error(`Input "${inp.label || inp.name}" must be a number`); return;
      }
    }
    setSubmitting(true);
    try {
      const inputs: Record<string, string | number | boolean> = {};
      for (const inp of selected.inputs || []) {
        const raw = inputValues[inp.name];
        if (raw === undefined || raw === '') continue;
        inputs[inp.name] = coerceValue(inp.type, raw);
      }
      const inst = await api.instantiatePipelineTemplate(selected.id, {
        project: project.trim(),
        organization,
        pipelineName: pipelineName.trim() || undefined,
        inputs,
      });
      if (!inst.success || !inst.data) {
        toast.error((inst as { message?: string }).message || 'Failed to render template');
        setSubmitting(false);
        return;
      }

      const created = await api.createPipeline({
        project: project.trim(),
        organization,
        pipelineName: pipelineName.trim() || undefined,
        description: inst.data.description,
        keywords: inst.data.keywords,
        accessModifier: 'private',
        props: inst.data.props,
      });
      if (created.success && created.data) {
        toast.success('Pipeline created from template');
        setSelected(null);
        void router.push(`/dashboard/pipelines/${created.data.pipeline.id}`);
      } else {
        // Surface the real reason (compliance / quota / validation), not a generic message.
        toast.error((created as { message?: string }).message || 'Template rendered, but pipeline creation failed');
      }
    } catch (err) {
      toast.error(formatError(err, 'Failed to create pipeline from template'));
    } finally {
      setSubmitting(false);
    }
  };

  const modalFooter = (
    <div className="flex items-center justify-end gap-3">
      <Button variant="secondary" onClick={() => setSelected(null)} disabled={submitting}>Cancel</Button>
      <Button onClick={handleCreate} loading={submitting} disabled={!canWrite} title={canWrite ? undefined : 'Requires pipelines:write'}>Create pipeline</Button>
    </div>
  );

  const gallery = useMemo(() => templates, [templates]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Templates"
      subtitle="Golden-path starters — instantiate a governed pipeline in a few fields"
      actions={
        <div className="flex items-center gap-2">
          {canWrite && (
            <Button onClick={() => setShowCreate(true)}>
              <LayoutTemplate className="w-4 h-4 mr-1.5" /> New template
            </Button>
          )}
          <IconButton onClick={fetchAll} title="Refresh" aria-label="Refresh" disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </IconButton>
        </div>
      }
    >
      <div className="page-section">
        <ResourceList<PipelineTemplate>
          loading={loading}
          error={error}
          onRefresh={fetchAll}
          isEmpty={gallery.length === 0}
          errorTitle="Failed to load templates"
          emptyState={{
            icon: LayoutTemplate,
            title: 'No templates yet',
            description: 'Golden-path templates published to your org (or the shared system catalog) appear here.',
          }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {gallery.map((t) => (
              <Card key={t.id} className="flex flex-col p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold text-gray-900 dark:text-gray-100">{t.name}</h3>
                  <span className="text-[11px] px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300">{t.category}</span>
                </div>
                {t.description && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 line-clamp-3">{t.description}</p>}
                <div className="mt-2 text-xs text-gray-400">{(t.inputs?.length ?? 0)} input{(t.inputs?.length ?? 0) === 1 ? '' : 's'}</div>
                <div className="mt-auto pt-3">
                  <Button onClick={() => openInstantiate(t)} disabled={!canWrite} title={canWrite ? undefined : 'Requires pipelines:write'} className="w-full">
                    <Sparkles className="w-4 h-4 mr-1.5" /> Use template
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </ResourceList>
      </div>

      {selected && (
        <Modal title={`Use “${selected.name}”`} onClose={() => (submitting ? undefined : setSelected(null))} maxWidth="max-w-lg" footer={modalFooter}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Project <span className="text-red-500">*</span></label>
              <Input value={project} onChange={(e) => setProject(e.target.value)} placeholder="my-service" disabled={submitting} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Pipeline name</label>
              <Input value={pipelineName} onChange={(e) => setPipelineName(e.target.value)} placeholder="(defaults to org-project-pipeline)" disabled={submitting} />
            </div>

            {(selected.inputs?.length ?? 0) > 0 && (
              <div className="pt-2 border-t border-gray-200 dark:border-gray-700 space-y-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Template inputs</h4>
                {selected.inputs.map((inp) => (
                  <div key={inp.name}>
                    <label htmlFor={`tpl-input-${inp.name}`} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {inp.label || inp.name}
                      {inp.required && inp.default === undefined && <span className="text-red-500"> *</span>}
                    </label>
                    {inp.description && <p className="text-xs text-gray-400 mb-1">{inp.description}</p>}
                    {inp.type === 'boolean' ? (
                      <Checkbox
                        id={`tpl-input-${inp.name}`}
                        checked={Boolean(inputValues[inp.name])}
                        onChange={(e) => setInputValues((s) => ({ ...s, [inp.name]: e.target.checked }))}
                        disabled={submitting}
                        className="h-4 w-4"
                      />
                    ) : inp.options && inp.options.length > 0 ? (
                      <Select
                        id={`tpl-input-${inp.name}`}
                        value={String(inputValues[inp.name] ?? '')}
                        onChange={(e) => setInputValues((s) => ({ ...s, [inp.name]: e.target.value }))}
                        disabled={submitting}
                      >
                        <option value="">Select…</option>
                        {inp.options.map((o) => <option key={o} value={o}>{o}</option>)}
                      </Select>
                    ) : (
                      <Input
                        id={`tpl-input-${inp.name}`}
                        type={inp.type === 'number' ? 'number' : 'text'}
                        value={String(inputValues[inp.name] ?? '')}
                        onChange={(e) => setInputValues((s) => ({ ...s, [inp.name]: e.target.value }))}
                        disabled={submitting}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {showCreate && canWrite && (
        <CreateTemplateModal
          canPublish={canPublish}
          onClose={() => setShowCreate(false)}
          onCreated={fetchAll}
        />
      )}
    </DashboardLayout>
  );
}
