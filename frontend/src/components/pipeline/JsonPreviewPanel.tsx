// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Textarea } from '@/components/ui/Textarea';
import type { BuilderJsonPreview } from '@/hooks/useBuilderWizard';

interface JsonPreviewPanelProps {
  preview: BuilderJsonPreview;
  /** Editable (with "Apply to form") for an existing pipeline / template; read-only otherwise. */
  edit?: { subject: 'pipeline' | 'template'; disabled?: boolean };
}

/** The builder's props as JSON, above the modal footer. Renders nothing while closed. */
export function JsonPreviewPanel({ preview, edit }: JsonPreviewPanelProps) {
  if (!preview.open || preview.json === null || (!edit && !preview.json)) return null;
  const close = (
    <button onClick={preview.close} className="text-fg-subtle hover:text-fg text-sm transition-colors">
      Close
    </button>
  );

  if (!edit) {
    return (
      <div className="border-t border-default">
        <div className="flex items-center justify-between px-6 py-2 bg-surface-muted">
          <span className="text-sm font-medium text-fg-muted">JSON Preview</span>
          {close}
        </div>
        <pre className="px-6 py-4 text-xs font-mono text-fg overflow-x-auto max-h-64 overflow-y-auto bg-canvas">
          {preview.json}
        </pre>
      </div>
    );
  }

  return (
    <div className="border-t border-default">
      <div className="flex items-center justify-between px-6 py-2 bg-surface-muted">
        <span className="text-sm font-medium text-fg-muted">Edit JSON <span className="font-normal text-fg-subtle">— edit the {edit.subject} `props` directly, then Apply</span></span>
        <div className="flex items-center gap-3">
          <button
            onClick={preview.apply}
            disabled={edit.disabled}
            className="text-brand hover:text-brand-strong text-sm font-medium transition-colors disabled:opacity-50"
          >
            Apply to form
          </button>
          {close}
        </div>
      </div>
      <div className="px-6 py-3 bg-canvas">
        <Textarea
          value={preview.json}
          onChange={(e) => preview.setJson(e.target.value)}
          rows={14}
          spellCheck={false}
          className="font-mono text-xs w-full"
          disabled={edit.disabled}
        />
        {preview.error && <p className="mt-2 text-xs text-danger" role="alert">{preview.error}</p>}
        {preview.applied && !preview.error && <p className="mt-2 text-xs text-success">Applied to the form. Review the wizard, then Save.</p>}
      </div>
    </div>
  );
}
