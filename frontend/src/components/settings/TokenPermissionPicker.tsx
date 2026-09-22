// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ORG_ASSIGNABLE_CATEGORIES } from '@pipeline-builder/api-core/permissions';
import { Checkbox } from '@/components/ui/Checkbox';
import { SegmentedFilter } from '@/components/ui/SegmentedFilter';
import { inCatalogOrder, readOnlyPreset, type PermissionMode } from '@/components/settings/token-scopes';

interface TokenPermissionPickerProps {
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  /** The chosen subset (only meaningful in `selected` mode). */
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** What the person holds right now — the only permissions a subset may name. */
  held: readonly string[];
  disabled?: boolean;
}

/**
 * "Full access (your current permissions)" versus "Selected permissions" for a
 * personal access key or machine token, with the selection grouped by the SAME
 * catalog categories the role editor uses (`ORG_ASSIGNABLE_CATEGORIES`).
 *
 * Permissions the person doesn't hold are shown but disabled: the API refuses a
 * subset that names one, and hiding them would make "why can't my key do X?"
 * unanswerable. Whatever is chosen, the credential can never exceed what its
 * owner holds at the moment it is used — a role lost later shrinks it.
 */
export function TokenPermissionPicker({
  mode, onModeChange, selected, onSelectedChange, held, disabled = false,
}: TokenPermissionPickerProps) {
  const mine = new Set(held);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onSelectedChange(next);
  };

  return (
    <div className="space-y-2">
      <SegmentedFilter<PermissionMode>
        ariaLabel="Key permissions"
        value={mode}
        onChange={(m) => { if (!disabled) onModeChange(m); }}
        options={[
          { value: 'selected', label: 'Selected permissions' },
          { value: 'full', label: 'Full access (your current permissions)' },
        ]}
      />

      {mode === 'full' ? (
        <p className="text-xs text-fg-muted">
          The credential acts with everything you can do in this organization — now and as your roles change.
          Prefer <strong>Selected permissions</strong> for automation that only needs part of that.
        </p>
      ) : (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-fg-muted">{selected.size} selected ·</span>
            <button type="button" className="text-brand hover:underline disabled:opacity-50" disabled={disabled}
              onClick={() => onSelectedChange(new Set(readOnlyPreset(held)))}>
              Read-only preset
            </button>
            <button type="button" className="text-brand hover:underline disabled:opacity-50" disabled={disabled}
              onClick={() => onSelectedChange(new Set())}>
              Clear
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto border border-default rounded-lg divide-y divide-default">
            {ORG_ASSIGNABLE_CATEGORIES.map(({ category, permissions }) => (
              <div key={category} className="p-2.5">
                <p className="text-2xs font-semibold uppercase tracking-wide text-fg-muted">{category}</p>
                <div className="mt-1.5 space-y-1.5">
                  {permissions.map((p) => {
                    const holds = mine.has(p.id);
                    return (
                      <label key={p.id} className={`flex items-start gap-2 text-xs ${holds ? 'cursor-pointer' : 'opacity-50'}`}>
                        <Checkbox
                          checked={selected.has(p.id)}
                          onChange={() => toggle(p.id)}
                          disabled={disabled || !holds}
                          className="mt-0.5"
                          aria-label={p.label}
                        />
                        <span className="min-w-0">
                          <span className="font-medium text-fg">{p.label}</span>
                          {!holds && <span className="ml-1 text-fg-muted">(you don&apos;t hold this)</span>}
                          <span className="block text-fg-muted">{p.description}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {selected.size === 0 && (
            <p className="text-xs text-danger">Choose at least one permission, or switch to full access.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The `permissions` field to send for a picker state (`undefined` = full access). */
export function permissionsForRequest(mode: PermissionMode, selected: ReadonlySet<string>): string[] | undefined {
  return mode === 'full' ? undefined : inCatalogOrder(selected);
}
