// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { TOKEN_SCOPE_OPTIONS } from '@/components/settings/token-scopes';
import type { ServiceAccount } from '@/lib/api/domains/organizations';
import type { ServiceAccountAction } from './service-account-actions';

interface ServiceAccountKeysProps {
  account: ServiceAccount;
  issuing: boolean;
  readOnly: boolean;
  onCancel: () => void;
  /** The validated key request, held by the parent for step-up. */
  onRequest: (action: Extract<ServiceAccountAction, { kind: 'key' }>) => void;
}

/** The new-key form for one account: name, expiry, IP allowlist and an optional single capability. */
export function ServiceAccountKeys({ account, issuing, readOnly, onCancel, onRequest }: ServiceAccountKeysProps) {
  const toast = useToast();
  const [draft, setDraft] = useState({ name: `${account.name}-key`, days: 90, ips: '', scope: '' });

  const issue = () => {
    if (!draft.name.trim()) { toast.error('Key name is required'); return; }
    const days = Math.floor(Number(draft.days));
    if (!Number.isFinite(days) || days < 1 || days > 365) { toast.error('Expiry must be 1-365 days'); return; }
    onRequest({
      kind: 'key',
      accountId: account.id,
      accountName: account.name,
      name: draft.name.trim(),
      expiresIn: days * 86400,
      ipAllowlist: draft.ips.split(',').map((s) => s.trim()).filter(Boolean),
      scope: draft.scope,
    });
  };

  return (
    <div className="mt-4 rounded-lg border border-default p-3">
      <div className="flex flex-wrap items-end gap-2">
        <FormField label="Key name" className="flex-1 min-w-[160px]">
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={100} />
        </FormField>
        <FormField label="Expires (days)" className="w-32">
          <Input type="number" min={1} max={365} value={draft.days} onChange={(e) => setDraft({ ...draft, days: Number(e.target.value) })} />
        </FormField>
        <FormField label="IP allowlist" className="flex-1 min-w-[200px]" hint="Optional, comma-separated IPs or CIDRs">
          <Input value={draft.ips} onChange={(e) => setDraft({ ...draft, ips: e.target.value })} placeholder="203.0.113.7, 10.0.0.0/8" />
        </FormField>
        <FormField
          label="Capability"
          className="min-w-[220px]"
          hint={draft.scope
            ? 'Least privilege: this key can do only that, and carries none of the account’s roles.'
            : 'The key acts with the account’s full roles.'}
        >
          <Select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>
            <option value="">Account roles (no scope)</option>
            {TOKEN_SCOPE_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </FormField>
        <Button onClick={issue} loading={issuing} readOnly={readOnly}>Issue key</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
