// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import type { ServiceAccount } from '@/lib/api/domains/organizations';
import { BUDGET_ERROR, BUDGET_HINT, parseTokenBudget, type ServiceAccountAction } from './service-account-actions';

interface ServiceAccountDetailsProps {
  account: ServiceAccount;
  saving: boolean;
  readOnly: boolean;
  onCancel: () => void;
  /** The CHANGED fields, held by the parent for step-up. */
  onRequest: (action: Extract<ServiceAccountAction, { kind: 'details' }>) => void;
}

/**
 * Inline editor for an account's description and token budget (roles and
 * enable/disable have their own controls on the card).
 */
export function ServiceAccountDetails({ account, saving, readOnly, onCancel, onRequest }: ServiceAccountDetailsProps) {
  const toast = useToast();
  const [description, setDescription] = useState(account.description ?? '');
  const [budget, setBudget] = useState(account.tokenBudget === -1 ? '' : String(account.tokenBudget));

  const save = () => {
    const tokenBudget = parseTokenBudget(budget);
    if (tokenBudget === null) {
      toast.error(BUDGET_ERROR);
      return;
    }
    const nextDescription = description.trim();
    const changes: { description?: string | null; tokenBudget?: number } = {};
    // `null` clears the description on the server; an unchanged value isn't sent.
    if (nextDescription !== (account.description ?? '')) changes.description = nextDescription || null;
    if (tokenBudget !== account.tokenBudget) changes.tokenBudget = tokenBudget;
    if (Object.keys(changes).length === 0) { onCancel(); return; }
    onRequest({ kind: 'details', accountId: account.id, accountName: account.name, changes });
  };

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md bg-surface-muted p-2">
      <FormField label="Description" className="flex-1 min-w-[180px]" hint="Leave empty to clear it.">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={256}
          aria-label={`Description for ${account.name}`}
        />
      </FormField>
      <FormField label="Token budget" className="w-44" hint={BUDGET_HINT}>
        <Input
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          placeholder="Unlimited"
          inputMode="numeric"
          aria-label={`Token budget for ${account.name}`}
        />
      </FormField>
      <Button size="xs" onClick={save} readOnly={readOnly} loading={saving}>Save</Button>
      <Button variant="ghost" size="xs" onClick={onCancel}>Cancel</Button>
    </div>
  );
}
