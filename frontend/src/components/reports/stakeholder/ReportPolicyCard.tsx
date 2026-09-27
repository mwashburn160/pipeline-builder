// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
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

  useEffect(() => {
    setExternalSharing(policy?.externalSharing ?? false);
    setRequireApproval(policy?.requireApproval ?? true);
    setDomains((policy?.recipientDomains ?? []).join(', '));
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

        {canEdit && (
          <Button type="submit" size="sm" loading={form.loading} readOnly={readOnly}>Save policy</Button>
        )}
      </form>
    </Card>
  );
}
