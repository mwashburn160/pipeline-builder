// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Select } from '@/components/ui/Select';
import { useFetch } from '@/hooks/useFetch';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';
import { queries } from '@/lib/api-cache';
import { runQuery } from '@/lib/query-cache';
import type { ReportDefinition } from '@/lib/api/domains/stakeholder-reports';

interface ReportTransferDialogProps {
  definition: ReportDefinition;
  /** The active organization, for the member roster. */
  orgId: string;
  readOnly?: boolean;
  onClose: () => void;
  /** Called after a successful transfer, so the list reflects the new owner. */
  onTransferred: () => void;
}

/**
 * Hand a report to a new owner.
 *
 * WHY THIS EXISTS AS A CONTROL AT ALL. A scheduled run is authorized AS the
 * definition's owner, so when that person leaves the organization or loses
 * `reports:author` the scheduler pauses the report — and the paused banner tells the
 * admin to transfer it. Until now there was nothing to click: the API route and the
 * CLI's `report transfer` both worked, and the UI's own remediation advice was
 * impossible to follow. Worse, the Resume button next to it looked like the answer and
 * was not: the scheduler re-checks authority on EVERY run, so resuming without
 * transferring re-pauses on the next tick, with the same message.
 *
 * THE SERVER DECIDES WHO MAY OWN IT. The new owner must be an active member holding
 * `reports:author`, verified against platform at transfer time — and that check fails
 * CLOSED, so an unreachable platform refuses rather than parking the report on an
 * unverified account. This dialog therefore does not try to pre-filter the roster by
 * permission: it cannot see per-member permissions, and a picker that hid valid
 * candidates (or offered invalid ones as if they would work) would be a second,
 * wrong copy of the rule. It shows the roster and surfaces the server's refusal in
 * the server's own words.
 */
export function ReportTransferDialog({
  definition, orgId, readOnly = false, onClose, onTransferred,
}: ReportTransferDialogProps) {
  const form = useFormState();
  const [ownerId, setOwnerId] = useState('');

  // The active roster (200 = the backend's page cap). A roster failure leaves the
  // picker empty and says so, rather than rendering a dialog that looks broken.
  const roster = useFetch(async (signal) => {
    const res = await runQuery(queries.orgMembers(orgId, { limit: 200, status: 'active' }), { signal });
    return res?.data?.members ?? [];
  }, [orgId]);

  // The current owner is not a candidate — transferring to them is a no-op that
  // would still spend an audit event and still leave the report paused.
  const candidates = useMemo(
    () => (roster.data ?? []).filter((m) => m.id !== definition.ownerId),
    [roster.data, definition.ownerId],
  );

  const transfer = async () => {
    if (!ownerId) return;
    await form.run(
      async () => {
        const res = await api.transferReportOwnership(definition.id, ownerId);
        if (!res.success) throw new Error('Could not transfer the report');
        return res;
      },
      { onSuccess: () => { onTransferred(); onClose(); } },
    );
  };

  const footer = (
    <ModalFooter
      onCancel={onClose}
      onConfirm={transfer}
      confirmLabel="Transfer"
      loading={form.loading}
      confirmDisabled={!ownerId || readOnly}
    />
  );

  return (
    <Modal title={`Transfer “${definition.name}”`} onClose={onClose} maxWidth="max-w-md" footer={footer}>
      <div className="space-y-3">
        <p className="text-sm text-fg-muted">
          Scheduled runs are authorized as the report&apos;s owner, so the new owner decides what the
          report can see. They must be an active member who can author reports.
        </p>

        <ErrorAlert message={form.error ?? (roster.error ? 'Could not load the member list.' : null)} onDismiss={form.reset} />

        <FormField label="New owner" hint={roster.loading ? 'Loading members…' : undefined}>
          <Select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            disabled={roster.loading || candidates.length === 0}
            data-testid="report-transfer-owner"
          >
            <option value="">Choose a member…</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.username}{' — '}{m.email}{m.role === 'member' ? '' : ` (${m.role})`}
              </option>
            ))}
          </Select>
        </FormField>

        {!roster.loading && candidates.length === 0 && (
          <p className="text-sm text-warning-strong" data-testid="report-transfer-empty">
            This organization has no other active member to transfer it to. Invite someone, or give an
            existing member permission to author reports.
          </p>
        )}
      </div>

    </Modal>
  );
}
