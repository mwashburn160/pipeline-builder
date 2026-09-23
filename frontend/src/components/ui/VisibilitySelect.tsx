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

/**
 * Says so explicitly for PLUGINS, because they are the one resource with a
 * second, external meaning of "public": the plugin directory at /plugins.
 * Every rung of this ladder — "Public" included — stays inside the org
 * hierarchy, so without this the picker reads as the way to publish to the
 * directory, which it is not. Listing there is a separate flow that does not
 * start in this dialog.
 */
export const ECOSYSTEM_VISIBILITY_NOTE =
  ' None of these list the plugin in the public plugin directory — that is a separate step:'
  + ' register a publisher at /marketplace/register to publish under your own handle,'
  + ' or submit anonymously at /plugins/submit (it lands under the `community` publisher after review).';

/**
 * Hint under the picker, explaining what the caller can and can't reach.
 *
 * `ecosystem` appends {@link ECOSYSTEM_VISIBILITY_NOTE} — pass it for plugins.
 */
export function visibilityHint(canPublish: boolean, publishPermission: string, ecosystem = false): string {
  const base = canPublish
    ? 'Private keeps it as a personal draft. Org shares it with everyone in your organization. Public also reaches your org’s teams — the shared SYSTEM catalog (all orgs) is a superadmin action from the system org.'
    : `Private keeps it as a personal draft; Org shares it with everyone in your organization. Sharing it publicly needs the ${publishPermission} permission.`;
  return ecosystem ? base + ECOSYSTEM_VISIBILITY_NOTE : base;
}
