// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { Upload, FileUp } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { FormField } from '@/components/ui/FormField';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { BuilderProps, TemplateInput } from '@/types';

interface ImportTemplateModalProps {
  /** `pipelines:publish` — required to import a PUBLIC template. */
  canPublish: boolean;
  onClose: () => void;
  onImported: () => void;
}

/** Shape we accept for import — the createPipelineTemplate body, or a full
 *  exported PipelineTemplate (extra fields like id/orgId are ignored). */
interface ImportedTemplate {
  name?: string;
  description?: string;
  keywords?: string[];
  category?: string;
  accessModifier?: 'public' | 'private';
  props?: BuilderProps;
  inputs?: TemplateInput[];
}

/**
 * Import a golden pipeline template from JSON — paste it or upload a .json file
 * — instead of only capturing one from an existing pipeline. Validates the
 * minimum shape (name + props) client-side; the server re-validates.
 */
export function ImportTemplateModal({ canPublish, onClose, onImported }: ImportTemplateModalProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setText(await file.text());
      setError(null);
    } catch (err) {
      setError(formatError(err, 'Could not read the file'));
    }
  };

  const handleImport = async () => {
    setError(null);
    setSuccess(null);
    let parsed: ImportedTemplate;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('Invalid JSON — paste a template export or a { name, props, inputs } object.');
      return;
    }
    if (!parsed || typeof parsed !== 'object') { setError('JSON must be a template object.'); return; }
    if (!parsed.name?.trim()) { setError('Template JSON is missing a "name".'); return; }
    if (!parsed.props || typeof parsed.props !== 'object') { setError('Template JSON is missing a "props" (BuilderProps) object.'); return; }

    // Public requires pipelines:publish — downgrade to private otherwise so the
    // import doesn't hard-fail on a permission the operator can't grant here.
    const access: 'public' | 'private' = parsed.accessModifier === 'public' && canPublish ? 'public' : 'private';

    setSaving(true);
    try {
      const res = await api.createPipelineTemplate({
        name: parsed.name.trim(),
        description: parsed.description?.trim() || undefined,
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k) => typeof k === 'string') : undefined,
        category: parsed.category?.trim() || 'general',
        accessModifier: access,
        props: parsed.props,
        inputs: Array.isArray(parsed.inputs) ? parsed.inputs : [],
      });
      if (res.success) {
        const note = parsed.accessModifier === 'public' && !canPublish ? ' (imported as private — publishing needs pipelines:publish)' : '';
        setSuccess(`Template "${parsed.name.trim()}" imported${note}.`);
        onImported();
        setTimeout(() => { if (mountedRef.current) onClose(); }, 1500);
      } else {
        setError(res.message || 'Failed to import template.');
      }
    } catch (err) {
      setError(formatError(err, 'Failed to import template'));
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <ModalFooter
      onCancel={onClose}
      onConfirm={handleImport}
      loading={saving}
      confirmDisabled={!text.trim()}
      confirmLabel={<span className="inline-flex items-center gap-2"><Upload className="w-4 h-4" />Import template</span>}
    />
  );

  return (
    <Modal title="Import template" onClose={onClose} maxWidth="max-w-lg" tall footer={footer}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Paste a template JSON (or upload a <code>.json</code> file). Expected shape: <code>{'{ name, category?, description?, keywords?, props, inputs? }'}</code>. A full exported template also works — extra fields are ignored.
        </p>

        <ErrorAlert message={error} />
        <SuccessAlert message={success} />

        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={saving}>
            <FileUp className="w-4 h-4 mr-1.5" /> Upload .json
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }}
          />
        </div>

        <FormField label="Template JSON">
          <Textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setError(null); }}
            rows={12}
            className="font-mono text-xs"
            placeholder={'{\n  "name": "node-service",\n  "category": "backend",\n  "inputs": [{ "name": "repoUrl", "label": "Repository URL", "type": "string", "required": true }],\n  "props": { "synth": { "source": { "repositoryUrl": "{{ vars.repoUrl }}" } }, "stages": [] }\n}'}
            disabled={saving}
          />
        </FormField>
      </div>
    </Modal>
  );
}
