// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId, useState } from 'react';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Textarea } from '@/components/ui/Textarea';
import api from '@/lib/api';
import { REPORT_CATEGORIES, REPORT_CATEGORY_LABELS, REPORT_REASON_MAX, reviewErrorMessage } from '@/lib/plugin-reviews';
import type { ReviewReportCategory } from '@/types/plugin-reviews';

/**
 * Report a review. A `security` report is private: it goes to the publisher and
 * the platform moderators and is never posted publicly.
 */
export function ReportReviewDialog({ reviewId, onReported, onClose }: {
  reviewId: string;
  onReported: () => void;
  onClose: () => void;
}) {
  const [category, setCategory] = useState<ReviewReportCategory | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();
  const reasonId = useId();

  const submit = async () => {
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      await api.reportReview(reviewId, category, reason.trim() || undefined);
      onReported();
      onClose();
    } catch (err) {
      setError(reviewErrorMessage(err, 'Could not send the report', { DUPLICATE_ENTRY: 'You have already reported this review.' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Report this review"
      onClose={() => { if (!busy) onClose(); }}
      maxWidth="max-w-lg"
      footer={(
        <ModalFooter
          onCancel={onClose}
          onConfirm={() => void submit()}
          confirmLabel="Send report"
          loading={busy}
          confirmDisabled={!category}
        />
      )}
    >
      <div className="space-y-4 text-sm">
        <fieldset className="space-y-2">
          <legend className="mb-1 font-medium text-fg">What is wrong with it?</legend>
          {REPORT_CATEGORIES.map((c) => (
            <label key={c} className="flex items-center gap-2 text-fg">
              <input
                type="radio"
                name={name}
                value={c}
                checked={category === c}
                onChange={() => setCategory(c)}
                disabled={busy}
              />
              {REPORT_CATEGORY_LABELS[c]}
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-fg-muted" data-testid="security-report-note">
          Security reports are sent privately to the plugin’s publisher and the platform moderators. They never appear publicly.
        </p>
        <FormField label="Details" id={reasonId} hint={`Optional, up to ${REPORT_REASON_MAX} characters.`}>
          <Textarea id={reasonId} rows={3} value={reason} maxLength={REPORT_REASON_MAX} onChange={(e) => setReason(e.target.value)} disabled={busy} />
        </FormField>
        <ErrorAlert message={error} onDismiss={() => setError(null)} />
      </div>
    </Modal>
  );
}
