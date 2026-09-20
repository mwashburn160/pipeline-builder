// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
import { formatError } from '@/lib/constants';
import type { BulkCreateResult, BulkPipelineSpec } from '@/lib/api/domains/pipelines';

/**
 * Parse the pasted import text: a bare JSON array of pipeline specs, or a
 * `{ "pipelines": [...] }` envelope (whichever shape the user exported).
 * Returns the specs, or the message to show.
 */
export function parseBulkPipelineSpecs(text: string): { specs: BulkPipelineSpec[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'Invalid JSON. Paste a valid JSON array of pipeline specs.' };
  }
  const arr = Array.isArray(parsed) ? parsed : ((parsed as { pipelines?: unknown } | null)?.pipelines ?? null);
  if (!Array.isArray(arr) || arr.length === 0) {
    return { error: 'Provide a non-empty JSON array of pipeline specs (or a { "pipelines": [...] } object).' };
  }
  return { specs: arr as BulkPipelineSpec[] };
}

/**
 * Bulk-create pipelines from pasted JSON (`POST /pipelines/bulk/create`,
 * `bulk_operations` feature). Reports per-item outcomes so a partial success is
 * surfaced, not masked; drops the shared pipeline cache and tells the caller
 * whenever anything was written.
 */
export default function BulkImportPipelinesModal({ onClose, onImported }: {
  onClose: () => void;
  /** Called after a request that created or updated at least one pipeline. */
  onImported: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkCreateResult | null>(null);

  const handleImport = async () => {
    setError(null);
    setResult(null);
    const parsed = parseBulkPipelineSpecs(text);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }

    setCreating(true);
    try {
      const res = await api.bulkCreatePipelines(parsed.specs);
      if (res.success && res.data) {
        setResult(res.data);
        invalidate.pipelines();
        onImported();
        const { created, updated, failed } = res.data;
        if (failed === 0) {
          toast.success(`${created} created${updated > 0 ? `, ${updated} updated` : ''}`);
        } else {
          toast.error(`${created} created, ${failed} failed`);
        }
      } else {
        setError(formatError(res, 'Bulk create failed'));
      }
    } catch (err) {
      setError(formatError(err, 'Bulk create failed'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      title="Bulk import pipelines"
      onClose={() => creating ? undefined : onClose()}
      maxWidth="max-w-2xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={creating}>
            Close
          </Button>
          <Button onClick={handleImport} disabled={creating || !text.trim()}>
            {creating ? 'Importing…' : 'Import'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-fg-muted">
          Paste a JSON array of pipeline specs (each with <code className="font-mono">project</code>, <code className="font-mono">organization</code>, and <code className="font-mono">props</code>; optional <code className="font-mono">pipelineName</code>, <code className="font-mono">description</code>, <code className="font-mono">keywords</code>, <code className="font-mono">visibility</code>). A <code className="font-mono">{'{ "pipelines": [...] }'}</code> wrapper is also accepted.
        </p>
        <Textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setError(null); }}
          placeholder={'[\n  { "project": "web", "organization": "acme", "props": { /* BuilderProps */ } }\n]'}
          rows={12}
          className="font-mono text-xs w-full"
          disabled={creating}
          spellCheck={false}
        />
        {error && (
          <ErrorAlert message={error} />
        )}
        {result && (
          <div className="rounded-lg bg-surface-muted border border-default p-3 space-y-2">
            <div className="flex flex-wrap gap-2">
              <Badge color="green">{result.created} created</Badge>
              {result.updated > 0 && <Badge color="blue">{result.updated} updated</Badge>}
              {result.failed > 0 && <Badge color="red">{result.failed} failed</Badge>}
            </div>
            {result.errors.length > 0 && (
              <ul className="text-xs text-red-700 dark:text-red-300 space-y-1 max-h-40 overflow-y-auto">
                {result.errors.map((e) => (
                  <li key={e.index}>
                    <span className="font-mono">#{e.index}</span>: {e.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
