// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';
import type { ReportPolicy } from '@/lib/api/domains/stakeholder-reports';

interface ReportPolicyCardProps {
  policy: ReportPolicy | null;
  /** `org:settings` — the admin capability. A lead sees the policy, read-only. */
  canEdit: boolean;
  readOnly?: boolean;
  onChanged: () => void;
}

/**
 * Who a report may reach — the organization's decision, not the author's.
 *
 * On `org:settings` rather than `reports:author` for exactly that reason: if a
 * lead could widen the allowed domains or turn on public links, the policy would
 * be a suggestion. A lead still SEES it, so they understand why an address was
 * refused instead of filing a bug.
 */
export function ReportPolicyCard({ policy, canEdit, readOnly = false, onChanged }: ReportPolicyCardProps) {
  const form = useFormState();
  const [externalSharing, setExternalSharing] = useState(policy?.externalSharing ?? false);
  const [requireApproval, setRequireApproval] = useState(policy?.requireApproval ?? true);
  const [domains, setDomains] = useState((policy?.recipientDomains ?? []).join(', '));
  // The org's DEFAULTS for a new report. Empty means "no org default", which is not the
  // same as UTC: the create form then uses the lead's own browser zone.
  const [defaultTimezone, setDefaultTimezone] = useState(policy?.defaultTimezone ?? '');
  const [defaultWeekStart, setDefaultWeekStart] = useState(policy?.defaultWeekStart ?? '');

  useEffect(() => {
    setExternalSharing(policy?.externalSharing ?? false);
    setRequireApproval(policy?.requireApproval ?? true);
    setDomains((policy?.recipientDomains ?? []).join(', '));
    setDefaultTimezone(policy?.defaultTimezone ?? '');
    setDefaultWeekStart(policy?.defaultWeekStart ?? '');
  }, [policy]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const list = domains.split(',').map((d) => d.trim()).filter(Boolean);
    await form.run(
      async () => {
        const res = await api.updateReportPolicy({
          externalSharing,
          requireApproval,
          // An empty box means MEMBERS ONLY, which the API stores as null rather
          // than an empty list — the closed reading, not "anyone".
          recipientDomains: list.length > 0 ? list : null,
          // Empty clears the org default rather than saving an empty string, so "no
          // default" stays expressible.
          defaultTimezone: defaultTimezone.trim() || null,
          defaultWeekStart: defaultWeekStart.trim() || null,
        });
        if (!res.success) throw new Error('Could not save the policy');
        return res;
      },
      { successMessage: 'Saved', onSuccess: onChanged },
    );
  };

  return (
    <Card>
      <form onSubmit={save} className="space-y-4">
        <div>
          <h3 className="h3">Who reports may reach</h3>
          <p className="text-sm text-fg-muted">
            Set for the whole organization. Report authors cannot change it — otherwise the policy would only
            be a suggestion.
          </p>
        </div>
        <ErrorAlert message={form.error} onDismiss={form.reset} />
        {form.success && <p className="text-xs text-success-strong" role="status">{form.success}</p>}

        <FormField
          label="Allowed external domains"
          hint="Comma-separated, e.g. partner.test. Leave empty to deliver only to members of this organization."
        >
          <Input value={domains} onChange={(e) => setDomains(e.target.value)} disabled={!canEdit} placeholder="partner.test" />
        </FormField>

        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={requireApproval}
            disabled={!canEdit}
            onChange={(e) => setRequireApproval(e.target.checked)}
            className="mt-1"
          />
          <span>
            An external address needs an administrator&apos;s approval
            <span className="block text-xs text-fg-muted">
              On top of the email confirmation the recipient does themselves.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={externalSharing}
            disabled={!canEdit}
            onChange={(e) => setExternalSharing(e.target.checked)}
            className="mt-1"
          />
          <span>
            Allow public share links
            <span className="block text-xs text-fg-muted">
              Off by default. A link lets anyone holding it read the report until it expires or is revoked,
              without signing in — which is a decision for the organization to make once, not a checkbox on
              every report.
            </span>
          </span>
        </label>

        {/* The ORG'S DEFAULTS for a new report. Set once, here, so every lead's first
            report starts in the right zone instead of starting in UTC and being noticed a
            week later — when a Monday report has put Sunday evening's deploys in the wrong
            week. A per-report value always wins, so a distributed team can still cut one
            report in Chicago and another in Berlin. */}
        <FormField
          label="Default timezone for new reports"
          hint="IANA name, e.g. America/Chicago. Leave empty to use whatever timezone the person creating the report is in."
        >
          <Input
            value={defaultTimezone}
            onChange={(e) => setDefaultTimezone(e.target.value)}
            disabled={!canEdit}
            placeholder="America/Chicago"
          />
        </FormField>

        <FormField
          label="Default week start"
          hint="Which day a weekly period begins on. Leave empty for Monday."
        >
          <Select
            value={defaultWeekStart}
            onChange={(e) => setDefaultWeekStart(e.target.value)}
            disabled={!canEdit}
          >
            <option value="">No organization default (Monday)</option>
            <option value="monday">Monday</option>
            <option value="sunday">Sunday</option>
          </Select>
        </FormField>

        {canEdit && (
          <Button type="submit" size="sm" loading={form.loading} readOnly={readOnly}>Save policy</Button>
        )}
      </form>
    </Card>
  );
}
