// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Select } from '@/components/ui/Select';
import type { Visibility } from '@/types';

/** Label + meaning of each rung, in ladder order (narrowest first). */
const RUNGS: { value: Visibility; label: string }[] = [
  { value: 'private', label: 'Private — only you' },
  { value: 'org', label: 'Org — everyone in your organization' },
  { value: 'public', label: 'Public — shared with your org & its teams' },
];

/**
 * Sharing-rung picker for any catalog entity — pipelines, plugins, templates.
 * The single place the three-rung ladder is spelled out for the UI, so the
 * wording can't drift between the create, edit and import flows.
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
      className="disabled:bg-gray-100 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
      disabled={disabled}
    >
      {RUNGS.filter((r) => r.value !== 'public' || canPublish || value === 'public').map((r) => (
        <option key={r.value} value={r.value}>{r.label}</option>
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
