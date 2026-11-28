// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import api from '@/lib/api';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { useMutation } from '@/hooks/useMutation';
import { MfaRequiredError } from '@/lib/api/errors';
import { MAX_INCIDENT_GRANT, type SupportIncidentGrant } from '@/lib/api/domains/billing';
import type { OrganizationDetail } from '@/lib/api/domains/organizations-lifecycle';
import { formatError } from '@/lib/constants';

/** What the audit row keeps of a note (the route trims and slices to 500). */
const NOTE_MAX = 500;

/**
 * Grant one-time support incidents to an org's account: a single support case
 * each, for an org with no support contact to open one against. A concession
 * (goodwill after an outage, a trial, a make-good), never a sale.
 *
 * The balance lives on the account root's subscription, so a grant typed
 * against a team lands on its root, and the answer names where it landed.
 * There is no admin read of another org's balance; the grant's answer is the
 * new total. The route is system org + `support_cases:write` + step-up; the
 * page renders this card only for a holder.
 */
export function OrgSupportIncidentsCard({ org }: { org: OrganizationDetail }) {
  const [count, setCount] = useState('1');
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const [pending, setPending] = useState<SupportIncidentGrant | null>(null);
  const [result, setResult] = useState<string | null>(null);
  // The key of the grant not yet answered with success. A failed answer (a 502,
  // a dropped connection) does not prove the server did NOT apply it, so a
  // resubmit of the SAME grant reuses its key; an edited grant gets a new one.
  const keyRef = useRef<{ count: number; note: string; key: string } | null>(null);

  const grant = useMutation({
    fn: async (body: SupportIncidentGrant, stepUpToken: string) => {
      const res = await api.grantSupportIncidents(org.id, body, stepUpToken);
      if (!res.success || !res.data) throw new Error(res.message || 'The grant was refused');
      return res.data;
    },
    scopeKey: org.id,
    formatError: (e) => (e instanceof MfaRequiredError ? '' : formatError(e, 'Could not grant incidents')),
    onSuccess: (data, body) => {
      const where = data.accountOrgId !== org.id ? ` Held by the account root ${data.accountOrgId}.` : '';
      setResult(data.duplicate
        ? `Already granted: nothing new was added. Balance is ${data.balance}.${where}`
        : `Granted ${body.count} ${body.count === 1 ? 'incident' : 'incidents'}. Balance is now ${data.balance}.${where}`);
      keyRef.current = null;
      setCount('1');
      setNote('');
    },
  });

  const submit = () => {
    setResult(null);
    grant.reset();
    const n = count.trim() === '' ? NaN : Number(count);
    if (!Number.isInteger(n) || n < 1 || n > MAX_INCIDENT_GRANT) {
      setInvalid(`Enter a whole number from 1 to ${MAX_INCIDENT_GRANT}.`);
      return;
    }
    setInvalid(null);
    const trimmed = note.trim();
    const prior = keyRef.current;
    const key = prior && prior.count === n && prior.note === trimmed ? prior.key : `grant-${crypto.randomUUID()}`;
    keyRef.current = { count: n, note: trimmed, key };
    setPending({ count: n, ...(trimmed ? { note: trimmed } : {}), idempotencyKey: key });
  };

  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <LifeBuoy className="w-5 h-5 text-fg-muted" />
        <h3 className="text-base font-semibold text-fg">Support incidents</h3>
      </div>
      <p className="text-sm text-fg-muted mb-3">
        Grant one-time support cases to an account with no support contact: goodwill after an outage, a trial, or a make-good.
        {org.parentOrgId && ' Incidents pool at the account root, so a grant here lands on the parent’s balance.'}
      </p>
      <ErrorAlert message={grant.error} onDismiss={grant.reset} />
      {result && <p role="status" className="mb-3 rounded-lg bg-info-bg px-3 py-2 text-sm text-info-strong">{result}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-[8rem_1fr] gap-3">
        <FormField label="Incidents" error={invalid ?? undefined}>
          <Input type="number" min={1} max={MAX_INCIDENT_GRANT} step={1} inputMode="numeric" value={count}
            onChange={(e) => setCount(e.target.value)} disabled={grant.pending} />
        </FormField>
        <FormField label="Note (optional, recorded in the audit log)">
          <Input value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} disabled={grant.pending}
            placeholder="Why this concession" />
        </FormField>
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="sm" onClick={submit} loading={grant.pending}>Grant incidents</Button>
      </div>

      {pending && (
        <StepUpModal
          title="Grant support incidents?"
          action={`Grant ${pending.count} support ${pending.count === 1 ? 'incident' : 'incidents'} to ${org.name}`}
          details={<p>Each one lets the account open a single support case without a support contact. Grants cannot be taken back.</p>}
          onConfirmed={async (stepUpToken) => { await grant.run(pending, stepUpToken); }}
          onClose={() => setPending(null)}
        />
      )}
    </Card>
  );
}
