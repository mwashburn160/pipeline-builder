// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { Callout } from '@/components/ui/Callout';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { ExposureTriageBody, PipelineExposureView } from '@/lib/api/pipeline-security-types';
import { RISK_ACCEPTANCE_MAX_DAYS, acceptanceWindow, triageBody, triageProblem } from '@/lib/pipeline-security';

const TITLES: Record<ExposureTriageBody['action'], string> = {
  accept: 'Accept the risk',
  false_positive: 'Mark as a false positive',
  reopen: 'Reopen the exposure',
};

const CONFIRM: Record<ExposureTriageBody['action'], string> = {
  accept: 'Accept risk',
  false_positive: 'Mark false positive',
  reopen: 'Reopen',
};

/**
 * Triage one exposure for this pipeline. Accepting needs a reason and a date at
 * most {@link RISK_ACCEPTANCE_MAX_DAYS} days out, and — only when the version
 * carries known-exploited (KEV) findings — an explicit acknowledgement. A
 * triage changes how loud the finding is for THIS pipeline; it never changes
 * whether the pipeline runs (it always does).
 */
export function ExposureTriageModal({ pipelineId, exposure, action, needsKev, onClose, onDone }: {
  pipelineId: string;
  exposure: PipelineExposureView;
  action: ExposureTriageBody['action'];
  needsKev: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const range = useMemo(() => acceptanceWindow(), []);
  const [reason, setReason] = useState('');
  const [day, setDay] = useState(range.defaultValue);
  const [kevAck, setKevAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = { action, reason, day, kevAck };
  const problem = triageProblem(draft, needsKev);

  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.triagePipelineExposure(pipelineId, exposure.id, triageBody(draft, needsKev));
      if (!res.success) throw new Error(res.message || 'Triage failed');
      toast.success(action === 'accept' ? 'Risk accepted for this pipeline' : action === 'false_positive' ? 'Marked as a false positive' : 'Exposure reopened');
      onDone();
    } catch (err) {
      setError(formatError(err, 'Triage failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={TITLES[action]}
      onClose={() => { if (!busy) onClose(); }}
      maxWidth="max-w-lg"
      footer={(
        <ModalFooter
          onCancel={onClose}
          onConfirm={() => void submit()}
          confirmLabel={CONFIRM[action]}
          loading={busy}
          confirmDisabled={!!problem}
        />
      )}
    >
      <div className="space-y-4" data-testid="exposure-triage-form">
        <p className="text-sm text-fg-muted">
          <span className="font-mono text-fg">{exposure.plugin}@{exposure.version}</span>
          {' — '}{exposure.criticalCount} Critical, {exposure.highCount} High
          {exposure.findingCount > 0 ? ` (${exposure.findingCount} finding${exposure.findingCount === 1 ? '' : 's'})` : ''}.
        </p>
        {action === 'accept' && (
          <p className="text-xs text-fg-muted">
            Warnings and notices about these findings drop to info for this pipeline until the date below. A finding that
            appears later is not covered.
          </p>
        )}
        {action !== 'reopen' && (
          <FormField label="Reason" required>
            <Textarea
              aria-label="Reason"
              rows={3}
              value={reason}
              maxLength={2000}
              onChange={(e) => setReason(e.target.value)}
              placeholder={action === 'accept' ? 'Why this risk is acceptable for now (compensating control, fix scheduled, …)' : 'Why the finding does not apply to this pipeline'}
            />
          </FormField>
        )}
        {action === 'reopen' && (
          <FormField label="Note (optional)">
            <Textarea aria-label="Note" rows={2} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
          </FormField>
        )}
        {action === 'accept' && (
          <FormField label="Accepted until" hint={`From tomorrow up to ${RISK_ACCEPTANCE_MAX_DAYS} days out.`} className="max-w-xs">
            <Input type="date" aria-label="Accepted until" min={range.min} max={range.max} value={day} onChange={(e) => setDay(e.target.value)} />
          </FormField>
        )}
        {action === 'accept' && needsKev && (
          <Callout variant="danger" title="Known exploited vulnerabilities">
            <label className="flex items-start gap-2">
              <Checkbox checked={kevAck} aria-label="Accept the known-exploited findings" onChange={(e) => setKevAck(e.target.checked)} />
              <span>
                This version has findings on the CISA Known Exploited Vulnerabilities list. I accept those too, knowing they
                are being exploited in the wild.
              </span>
            </label>
          </Callout>
        )}
        {problem && (reason.trim() || action === 'accept') && <p className="text-xs text-danger-strong">{problem}</p>}
        {error && <p className="text-sm text-danger-strong" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
