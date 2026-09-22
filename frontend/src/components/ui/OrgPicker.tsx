// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react';
import { Building2, Check, X } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { useCombobox } from '@/hooks/useCombobox';
import { useDebounce } from '@/hooks/useDebounce';
import { useQuery } from '@/hooks/useQuery';
import { queries } from '@/lib/api-cache';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';

/** Rows fetched per keystroke — a picker, not a listing. */
const SEARCH_PAGE = 20;
/** The org-list endpoint resolves at most this many ids per request. */
const IDS_PER_REQUEST = 100;

export interface OrgRef {
  id: string;
  name: string;
}

/**
 * Names for exactly the org ids a page shows (sysadmin only — the org list is
 * sysadmin-scoped). Reads `GET /organizations?ids=…` through the shared query
 * cache instead of paging the first N orgs of the fleet, which left every org
 * past the page cap rendered as a bare id. Unknown ids simply stay absent.
 */
export function useOrgNames(ids: readonly string[], enabled = true): Map<string, string> {
  const wanted = useMemo(
    () => [...new Set(ids.filter((id) => /^[a-f0-9]{24}$/i.test(id)))].sort().slice(0, IDS_PER_REQUEST),
    [ids],
  );
  const res = useQuery(enabled && wanted.length > 0
    ? queries.listOrganizations({ ids: wanted.join(','), limit: wanted.length })
    : null);
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const org of res.data?.data?.organizations ?? []) if (org.id && org.name) map.set(org.id, org.name);
    return map;
  }, [res.data]);
}

/** Server-side name/slug search over every org (sysadmin). */
function useOrgSearch(query: string, active: boolean) {
  const [options, setOptions] = useState<OrgRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api.listOrganizations({ ...(query ? { search: query } : {}), limit: SEARCH_PAGE }, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setOptions((res.data?.organizations ?? []).map((o) => ({ id: o.id, name: o.name })));
      })
      .catch((e) => { if (!ctrl.signal.aborted) { setOptions([]); setError(formatError(e, 'Search failed')); } })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [query, active]);
  return { options, loading, error };
}

interface OrgPickerProps {
  /** The selected org id, or `none.value`. */
  value: string;
  onChange: (id: string) => void;
  /** The "no specific org" choice (`''` → "— No organization —", `'all'` →
   *  "All organizations", …). Omit when an org must be chosen. */
  none?: { value: string; label: string };
  /** A name already known for `value` (skips a lookup, e.g. the row's own org). */
  valueName?: string;
  id?: string;
  'aria-label'?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

/**
 * Pick one organization, searched on the server.
 *
 * Replaces the `<select>`s that listed the first 100 orgs: past that cap an org
 * could not be chosen at all, and a user already IN one of them showed a blank
 * select — saving then silently moved them out. Here the current value is
 * always an option (named via {@link useOrgNames} when not otherwise known), and
 * every org is reachable by typing.
 */
export function OrgPicker({
  value, onChange, none, valueName, id, disabled, className = '', placeholder = 'Search organizations…',
  'aria-label': ariaLabel,
}: OrgPickerProps) {
  const [text, setText] = useState('');
  const box = useCombobox(setText);
  const query = useDebounce(text.trim(), 250);
  const search = useOrgSearch(query, box.open);
  const isNone = !value || (none !== undefined && value === none.value);
  const lookedUp = useOrgNames(isNone || valueName ? [] : [value]);
  const currentName = isNone ? none?.label ?? '' : valueName ?? lookedUp.get(value) ?? value;

  // The current value leads the list whether or not the search returned it.
  const options = useMemo<Array<{ id: string; name: string }>>(() => {
    const rows: Array<{ id: string; name: string }> = [];
    if (none && !query) rows.push({ id: none.value, name: none.label });
    if (!isNone && !search.options.some((o) => o.id === value)) rows.push({ id: value, name: currentName });
    return [...rows, ...search.options];
  }, [none, query, isNone, search.options, value, currentName]);

  const select = (o: { id: string }) => {
    onChange(o.id);
    setText('');
    box.dismiss();
  };

  return (
    <div ref={box.wrapperRef} className={`relative ${className}`}>
      <Input
        ref={box.inputRef}
        id={id}
        type="text"
        value={box.open ? text : currentName}
        onChange={box.handleInputChange}
        onFocus={() => { setText(''); box.setOpen(true); }}
        onKeyDown={(e) => box.handleKeyDown(e, options.length, (i) => select(options[i]))}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        disabled={disabled}
        className="text-sm"
        {...box.inputAriaProps}
      />
      {box.open && (
        <div role="listbox" id={box.listboxId} aria-label="Organizations" className="absolute z-50 mt-1 w-full max-h-60 overflow-auto bg-surface border border-default rounded-xl shadow-lg text-sm">
          {options.map((o, i) => (
            <button
              key={`${o.id}-${i}`}
              type="button"
              role="option"
              id={box.optionId(i)}
              aria-selected={o.id === value || (isNone && none?.value === o.id)}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => box.setActiveIndex(i)}
              onClick={() => select(o)}
              className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-fg ${i === box.activeIndex ? 'bg-info-bg' : 'hover:bg-blue-50 dark:hover:bg-blue-900/30'}`}
            >
              <Building2 className="w-3.5 h-3.5 text-fg-subtle shrink-0" aria-hidden />
              <span className="truncate flex-1">{o.name}</span>
              {(o.id === value || (isNone && none?.value === o.id)) && <Check className="w-3.5 h-3.5 text-brand" aria-hidden />}
            </button>
          ))}
          {search.loading && <div className="px-3 py-2 text-fg-muted" role="status">Searching…</div>}
          {!search.loading && search.error && <div className="px-3 py-2 text-danger">{search.error}</div>}
          {!search.loading && !search.error && search.options.length === 0 && (
            <div className="px-3 py-2 text-fg-muted">No matching organizations.</div>
          )}
        </div>
      )}
    </div>
  );
}

/** The platform's own unattributed lines — the sysadmin default tenant. */
export const INFRA_TENANT = '_infra';

interface OrgMultiPickerProps {
  /** Selected org ids (and/or {@link INFRA_TENANT}); `['all']` for every org. */
  value: string[];
  onChange: (next: string[]) => void;
  'aria-label'?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Pick several organizations (sysadmin log tenants). Empty means the default —
 * platform infrastructure only; "All organizations" is exclusive of the rest.
 */
export function OrgMultiPicker({ value, onChange, disabled, className = '', 'aria-label': ariaLabel = 'Organizations' }: OrgMultiPickerProps) {
  const [text, setText] = useState('');
  const box = useCombobox(setText);
  const query = useDebounce(text.trim(), 250);
  const search = useOrgSearch(query, box.open);
  const all = value.includes('all');
  const names = useOrgNames(value);
  const labelFor = (id: string) => (id === 'all' ? 'All organizations' : id === INFRA_TENANT ? 'Platform infrastructure' : names.get(id) ?? id);

  const options = useMemo(() => {
    const fixed = query ? [] : [{ id: 'all', name: 'All organizations' }, { id: INFRA_TENANT, name: 'Platform infrastructure' }];
    return [...fixed, ...search.options];
  }, [query, search.options]);

  const toggle = (id: string) => {
    if (id === 'all') {onChange(all ? [] : ['all']);}
    else {
      const rest = value.filter((v) => v !== 'all');
      onChange(rest.includes(id) ? rest.filter((v) => v !== id) : [...rest, id]);
    }
    setText('');
  };

  return (
    <div ref={box.wrapperRef} className={`relative ${className}`}>
      <div className="flex flex-wrap items-center gap-1">
        {value.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs text-fg">
            {labelFor(id)}
            <button type="button" onClick={() => onChange(value.filter((v) => v !== id))} disabled={disabled} aria-label={`Remove ${labelFor(id)}`} className="text-fg-subtle hover:text-fg">
              <X className="w-3 h-3" aria-hidden />
            </button>
          </span>
        ))}
        <Input
          ref={box.inputRef}
          type="text"
          value={text}
          onChange={box.handleInputChange}
          onFocus={() => box.setOpen(true)}
          onKeyDown={(e) => box.handleKeyDown(e, options.length, (i) => toggle(options[i].id))}
          placeholder={value.length ? 'Add organization…' : 'Platform infrastructure (default) — add organizations…'}
          aria-label={ariaLabel}
          autoComplete="off"
          disabled={disabled}
          className="text-xs min-w-[14rem] flex-1"
          {...box.inputAriaProps}
        />
      </div>
      {box.open && (
        <div role="listbox" aria-multiselectable="true" id={box.listboxId} aria-label="Organizations" className="absolute z-50 mt-1 w-full max-h-60 overflow-auto bg-surface border border-default rounded-xl shadow-lg text-sm">
          {options.map((o, i) => {
            const selected = value.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                id={box.optionId(i)}
                aria-selected={selected}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => box.setActiveIndex(i)}
                onClick={() => toggle(o.id)}
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-fg ${i === box.activeIndex ? 'bg-info-bg' : 'hover:bg-blue-50 dark:hover:bg-blue-900/30'}`}
              >
                <Building2 className="w-3.5 h-3.5 text-fg-subtle shrink-0" aria-hidden />
                <span className="truncate flex-1">{o.name}</span>
                {selected && <Check className="w-3.5 h-3.5 text-brand" aria-hidden />}
              </button>
            );
          })}
          {search.loading && <div className="px-3 py-2 text-fg-muted" role="status">Searching…</div>}
          {!search.loading && search.error && <div className="px-3 py-2 text-danger">{search.error}</div>}
        </div>
      )}
    </div>
  );
}
