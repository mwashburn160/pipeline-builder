// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { PipelineDeployment } from '@/lib/api/domains/pipelines';
import type { Pipeline } from '@/types';

/** The pipeline fields the register form needs — the page drains the rest. */
export type PipelineConfig = Pick<Pipeline, 'pipelineName' | 'project' | 'organization' | 'id'>;

/** Modal to register (upsert) a deployment for one of the org's pipelines. */
export function RegisterDeploymentModal({
  configs, onClose, onRegistered,
}: {
  configs: PipelineConfig[];
  onClose: () => void;
  onRegistered: (row: PipelineDeployment) => void;
}) {
  const [pipelineId, setPipelineId] = useState('');
  const [region, setRegion] = useState('');
  const [stackName, setStackName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = configs.find((c) => c.id === pipelineId);

  const handleSubmit = async () => {
    setErr(null);
    if (!pipelineId) {
      setErr('Select a pipeline to register.');
      return;
    }
    if (!selected) {
      setErr('Selected pipeline is no longer available. Refresh and try again.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.registerPipelineDeployment({
        pipelineId,
        pipelineName: selected.pipelineName || pipelineId,
        ...(region.trim() ? { region: region.trim() } : {}),
        ...(selected.project ? { project: selected.project } : {}),
        ...(selected.organization ? { organization: selected.organization } : {}),
        ...(stackName.trim() ? { stackName: stackName.trim() } : {}),
      });
      if (res.success && res.data) {
        onRegistered(res.data.registry);
      } else {
        setErr(formatError(res, 'Failed to register deployment'));
      }
    } catch (e) {
      setErr(formatError(e, 'Failed to register deployment'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Register deployment"
      onClose={() => submitting ? undefined : onClose()}
      maxWidth="max-w-lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting || !pipelineId}>
            {submitting ? 'Registering…' : 'Register'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 text-sm">
        <div>
          <label className="label">Pipeline</label>
          <Select
            value={pipelineId}
            onChange={(e) => { setPipelineId(e.target.value); setErr(null); }}
            disabled={submitting}
          >
            <option value="">Select a pipeline…</option>
            {configs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.pipelineName || c.id}{c.project ? ` — ${c.project}` : ''}
              </option>
            ))}
          </Select>
          {configs.length === 0 && (
            <p className="text-xs text-fg-muted mt-1">
              No pipeline configurations found. Create a pipeline first.
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Region <span className="text-fg-subtle">(optional)</span></label>
            <Input
              type="text"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="us-east-1"
              className="text-sm"
              disabled={submitting}
            />
          </div>
          <div>
            <label className="label">Stack name <span className="text-fg-subtle">(optional)</span></label>
            <Input
              type="text"
              value={stackName}
              onChange={(e) => setStackName(e.target.value)}
              placeholder="my-pipeline-stack"
              className="text-sm"
              disabled={submitting}
            />
          </div>
        </div>
        <p className="text-xs text-fg-muted">
          Registering maps this pipeline&apos;s stable id to its deployment so execution events report against it. Re-registering the same pipeline updates the existing record.
        </p>
        {err && (
          <ErrorAlert message={err} />
        )}
      </div>
    </Modal>
  );
}
