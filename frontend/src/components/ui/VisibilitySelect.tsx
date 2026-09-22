// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Select } from '@/components/ui/Select';
import { VISIBILITY_RUNGS } from '@/components/ui/visibility-rungs';
import type { Visibility } from '@/types';

/**
 * Sharing-rung picker for any catalog entity — pipelines, plugins, templates.
 * Its wording comes from VISIBILITY_RUNGS, shared with the table cell, so it
 * can't drift between the create, edit and import flows and the lists.
 *
 * `public` is gated on the resource's `:publish` permission, but ONLY that rung:
 * a member without it can still move a row between `private` and `org`. An
 * already-public row keeps its option visible so a non-publisher sees the
 * truthful current value rather than a blank select.
 */
export function VisibilitySelect({ value, onChange, canPublish, disabled, id }: {
  value: Visibility;
  onChange: (v: Visibility) => void;
  /** The resource's `:publish` permission — required for the `public` rung. */
  canPublish: boolean;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as Visibility)}
      className="disabled:bg-surface-muted disabled:text-fg-muted dark:disabled:text-gray-500"
      disabled={disabled}
    >
      {VISIBILITY_RUNGS.filter((r) => r.value !== 'public' || canPublish || value === 'public').map((r) => (
        <option key={r.value} value={r.value}>{`${r.label} — ${r.meaning}`}</option>
      ))}
    </Select>
  );
}

/** Hint under the picker, explaining what the caller can and can't reach. */
export function visibilityHint(canPublish: boolean, publishPermission: string): string {
  return canPublish
    ? 'Private keeps it as a personal draft. Org shares it with everyone in your organization. Public also reaches your org’s teams — the shared SYSTEM catalog (all orgs) is a superadmin action from the system org.'
    : `Private keeps it as a personal draft; Org shares it with everyone in your organization. Sharing it publicly needs the ${publishPermission} permission.`;
}
