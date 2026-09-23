// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, useId } from 'react';
import { Building2, X } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { useCombobox } from '@/hooks/useCombobox';
import { useDebounce } from '@/hooks/useDebounce';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';

/** An org that may parent a team: a top-level org on the team or enterprise tier. */
export interface ParentOrgOption {
  id: string;
  name: string;
  tier: 'team' | 'enterprise';
}

/** Tiers whose roots may parent teams (mirrors the platform's `checkParentEligible`). */
const TEAM_TIERS = ['team', 'enterprise'] as const;
/** Rows fetched per tier per keystroke — a picker, not a listing. */
const PAGE = 20;

/**
 * Server-side search for the orgs eligible to parent a team.
 *
 * The list endpoint filters by name/slug and by ONE tier, so both eligible tiers
 * are queried in parallel. It has no top-level filter, so teams (a `parentOrgId`)
 * and soft-deleted orgs are dropped here; `excludeOrgId` removes the org being
 * moved (an org can't parent itself).
 */
async function searchEligibleParents(
  search: string,
  opts: { excludeOrgId?: string; signal?: AbortSignal } = {},
): Promise<ParentOrgOption[]> {
  const pages = await Promise.all(TEAM_TIERS.map((tier) => api.listOrganizations(
    { ...(search ? { search } : {}), tier, limit: PAGE },
    { signal: opts.signal },
  )));
  return pages
    .flatMap((res, i) => (res.data?.organizations ?? [])
      .filter((o) => !o.parentOrgId && !o.pendingDeletion && o.id !== opts.excludeOrgId)
      .map((o) => ({ id: o.id, name: o.name, tier: TEAM_TIERS[i] })))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Typeahead over {@link searchEligibleParents}. Shows the selection as a chip;
 * clearing it re-opens the search. Only eligible roots are ever offered, so a
 * pick can't be refused for tier or nesting depth.
 */

const NO_OPTIONS: ParentOrgOption[] = [];

export function EligibleParentPicker({
  value,
  onChange,
  excludeOrgId,
  disabled,
  label = 'Parent organization',
}: {
  value: ParentOrgOption | null;
  onChange: (next: ParentOrgOption | null) => void;
  excludeOrgId?: string;
  disabled?: boolean;
  label?: string;
}) {
  const uid = useId();
  const [text, setText] = useState('');
  const box = useCombobox(setText);
  const query = useDebounce(text.trim(), 250);
  // `clearDataOnError` because this is a typeahead: keeping the last good answer
  // would leave options from a query the person has moved on from sitting next
  // to the error that says the search failed.
  const search = useFetch(
    (signal) => searchEligibleParents(query, { excludeOrgId, signal }),
    [box.open, query, excludeOrgId, value],
    { enabled: box.open && !value, clearDataOnError: true },
  );
  const options = search.data ?? NO_OPTIONS;
  const loading = search.loading;
  const error = search.error ? formatError(search.error, 'Search failed') : null;

  const select = (o: ParentOrgOption) => {
    onChange(o);
    setText('');
    box.dismiss();
  };

  if (value) {
    return (
      <div className="space-y-1">
        <span className="block text-xs font-medium text-fg-muted">{label}</span>
        <div className="flex items-center gap-2 rounded-lg border border-default px-3 py-1.5 text-sm">
          <Building2 className="w-3.5 h-3.5 text-fg-subtle shrink-0" />
          <span className="truncate flex-1">{value.name}</span>
          <span className="text-xs text-fg-subtle capitalize">{value.tier}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={disabled}
            aria-label={`Clear ${label.toLowerCase()}`}
            className="text-fg-subtle hover:text-fg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={box.wrapperRef} className="relative space-y-1">
      <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-field`}>{label}</label>
      <Input id={`${uid}-field`}
        ref={box.inputRef}
        type="text"
        value={text}
        onChange={box.handleInputChange}
        onFocus={() => box.setOpen(true)}
        onKeyDown={(e) => box.handleKeyDown(e, options.length, (i) => select(options[i]))}
        placeholder="Search Team or Enterprise organizations…"
        aria-label={label}
        autoComplete="off"
        disabled={disabled}
        className="text-sm"
        {...box.inputAriaProps}
      />
      {box.open && (
        <div role="listbox" id={box.listboxId} aria-label="Eligible parent organizations" className="absolute z-50 mt-1 w-full max-h-52 overflow-auto bg-surface border border-default rounded-xl shadow-lg text-sm">
          {loading ? (
            <div className="px-3 py-2 text-fg-muted" role="status">Searching…</div>
          ) : error ? (
            <div role="alert" className="px-3 py-2 text-danger">{error}</div>
          ) : options.length === 0 ? (
            <div className="px-3 py-2 text-fg-muted">
              No matching top-level organizations on the Team or Enterprise plan.
            </div>
          ) : options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              role="option"
              id={box.optionId(i)}
              aria-selected={i === box.activeIndex}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => box.setActiveIndex(i)}
              onClick={() => select(o)}
              className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-fg ${i === box.activeIndex ? 'bg-info-bg' : 'hover:bg-blue-50 dark:hover:bg-blue-900/30'}`}
            >
              <Building2 className="w-3.5 h-3.5 text-fg-subtle shrink-0" />
              <span className="truncate flex-1">{o.name}</span>
              <span className="text-xs text-fg-subtle capitalize">{o.tier}</span>
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-fg-muted">
        Only top-level organizations on the Team or Enterprise plan can have teams.
      </p>
    </div>
  );
}
