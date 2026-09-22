// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import type { OrganizationRole } from '@/types';
import { BUDGET_ERROR, BUDGET_HINT, parseTokenBudget, type ServiceAccountAction } from './service-account-actions';

interface CreateServiceAccountFormProps {
  roles: OrganizationRole[];
  busy: boolean;
  creating: boolean;
  readOnly: boolean;
  /** Validated create request, held by the parent for step-up. The parent
   *  remounts the form (via `key`) once the account exists, which clears it. */
  onRequest: (action: Extract<ServiceAccountAction, { kind: 'create' }>) => void;
}

/** Name, description, token budget and roles for a new service account. */
export function CreateServiceAccountForm({ roles, busy, creating, readOnly, onRequest }: CreateServiceAccountFormProps) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [budget, setBudget] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);

  const toggleRole = (id: string) => setRoleIds((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));

  const submit = () => {
    const trimmed = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(trimmed)) {
      toast.error('Name must be 2-64 characters: lowercase letters, digits, hyphen or underscore');
      return;
    }
    const tokenBudget = parseTokenBudget(budget);
    if (tokenBudget === null) {
      toast.error(BUDGET_ERROR);
      return;
    }
    onRequest({ kind: 'create', name: trimmed, description: description.trim() || undefined, roleIds, tokenBudget });
  };

  return (
    <>
      <div className="flex flex-wrap items-end gap-2 mb-2">
        <FormField label="Name" className="flex-1 min-w-[180px]" hint="Lowercase machine name, e.g. ci-deploy">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ci-deploy" maxLength={64} disabled={busy || readOnly} />
        </FormField>
        <FormField label="Description" className="flex-1 min-w-[180px]">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Deploys from CI" maxLength={256} disabled={busy || readOnly} />
        </FormField>
        <FormField label="Token budget" className="w-44" hint={BUDGET_HINT}>
          <Input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Unlimited" inputMode="numeric" disabled={busy || readOnly} />
        </FormField>
        <Button onClick={submit} loading={creating} readOnly={readOnly} className="gap-1">
          <Plus className="w-4 h-4" /> Create
        </Button>
      </div>
      {roles.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Roles for the new service account">
          {roles.map((role) => (
            <label key={role.id} className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={roleIds.includes(role.id)}
                onChange={() => toggleRole(role.id)}
                disabled={busy || readOnly}
              />
              {role.name}
            </label>
          ))}
        </div>
      )}
    </>
  );
}
