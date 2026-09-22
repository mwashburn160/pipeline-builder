// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from 'react';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ADVISORY_SEVERITIES, ADVISORY_SUMMARY_MAX, SEVERITY_LABELS, parseCveIds } from '@/lib/advisories';
import { formatError } from '@/lib/constants';
import type { AdvisoryInput, AdvisorySeverity, AdvisoryView } from '@/types/ecosystem';

export interface AdvisoryFormValue {
  listingId: string;
  /** Optional fields left empty are omitted, or sent as `null` when editing (to clear them). */
  advisory: AdvisoryInput;
}

interface Props {
  title: string;
  confirmLabel: string;
  /** The listing picker's options; omit when editing an existing advisory (its listing is fixed). */
  listings?: Array<{ id: string; label: string }>;
  listingsLoading?: boolean;
  /** Editing an existing draft: pre-fills every field. */
  initial?: AdvisoryView;
  intro?: ReactNode;
  /** Throws to keep the dialog open with the error shown; resolves = close. */
  onSubmit: (value: AdvisoryFormValue) => Promise<void>;
  onClose: () => void;
}

/**
 * The advisory form (plan W8) shared by the publisher's "Submit advisory"
 * request and the console's new-draft / edit-draft dialogs. The details are
 * raw markdown — edited here as text, never rendered (the server renders and
 * sanitizes them into `detailsHtml`).
 */
export function AdvisoryFormDialog({
  title, confirmLabel, listings, listingsLoading = false, initial, intro, onSubmit, onClose,
}: Props) {
  const editing = !!initial;
  const [listingId, setListingId] = useState(initial?.listingId ?? '');
  const [affectedRange, setAffectedRange] = useState(initial?.affectedRange ?? '');
  const [severity, setSeverity] = useState<AdvisorySeverity>(initial?.severity ?? 'high');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [detailsMd, setDetailsMd] = useState(initial?.detailsMd ?? '');
  const [cves, setCves] = useState(initial?.cveIds.join(', ') ?? '');
  const [fixedVersion, setFixedVersion] = useState(initial?.fixedVersion ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summaryTooLong = summary.trim().length > ADVISORY_SUMMARY_MAX;
  const incomplete = !listingId || !affectedRange.trim() || !summary.trim() || summaryTooLong;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const details = detailsMd.trim();
    const fixed = fixedVersion.trim();
    const cveIds = parseCveIds(cves);
    const advisory: AdvisoryInput = {
      affectedRange: affectedRange.trim(),
      severity,
      summary: summary.trim(),
      ...(editing
        ? { detailsMd: details || null, fixedVersion: fixed || null, cveIds }
        : {
          ...(details ? { detailsMd: details } : {}),
          ...(fixed ? { fixedVersion: fixed } : {}),
          ...(cveIds.length ? { cveIds } : {}),
        }),
    };
    try {
      await onSubmit({ listingId, advisory });
    } catch (err) {
      setError(formatError(err, 'Could not save the advisory'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={() => { if (!busy) onClose(); }}
      maxWidth="max-w-2xl"
      footer={(
        <ModalFooter
          onCancel={onClose}
          onConfirm={() => void submit()}
          confirmLabel={confirmLabel}
          loading={busy}
          confirmDisabled={incomplete}
        />
      )}
    >
      <div className="space-y-4 text-sm">
        {intro && <div className="space-y-2 text-fg-muted">{intro}</div>}
        {initial ? (
          <p className="text-fg-muted">Listing: <span className="font-mono text-fg">{initial.publisherHandle}/{initial.listingName}</span></p>
        ) : (
          <FormField label="Listing" required>
            <Select value={listingId} onChange={(e) => setListingId(e.target.value)} disabled={listingsLoading || busy}>
              <option value="">{listingsLoading ? 'Loading…' : (listings?.length ? 'Choose a listing…' : 'No listings')}</option>
              {(listings ?? []).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </Select>
          </FormField>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Affected versions" required hint="A semver range, e.g. >=1.0.0 <1.4.2">
            <Input value={affectedRange} onChange={(e) => setAffectedRange(e.target.value)} placeholder=">=1.0.0 <1.4.2" disabled={busy} />
          </FormField>
          <FormField label="Severity" required>
            <Select value={severity} onChange={(e) => setSeverity(e.target.value as AdvisorySeverity)} disabled={busy}>
              {ADVISORY_SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>)}
            </Select>
          </FormField>
        </div>
        <FormField
          label="Summary"
          required
          error={summaryTooLong ? `At most ${ADVISORY_SUMMARY_MAX} characters.` : undefined}
          hint={`${summary.trim().length}/${ADVISORY_SUMMARY_MAX}`}
        >
          <Input value={summary} onChange={(e) => setSummary(e.target.value)} disabled={busy} />
        </FormField>
        <FormField label="Details (markdown)" hint="Optional. Rendered and sanitized by the server.">
          <Textarea rows={6} value={detailsMd} onChange={(e) => setDetailsMd(e.target.value)} disabled={busy} className="font-mono text-xs" />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="CVE ids" hint="Comma or space separated, e.g. CVE-2026-1234">
            <Input value={cves} onChange={(e) => setCves(e.target.value)} disabled={busy} />
          </FormField>
          <FormField label="Fixed version" hint="Optional: the first version with the fix.">
            <Input value={fixedVersion} onChange={(e) => setFixedVersion(e.target.value)} placeholder="1.4.2" disabled={busy} />
          </FormField>
        </div>
        <ErrorAlert message={error} onDismiss={() => setError(null)} />
      </div>
    </Modal>
  );
}
