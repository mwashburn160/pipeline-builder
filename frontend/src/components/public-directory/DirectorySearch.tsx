// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The directory search box.
 *
 * A real `<form method="get" action="/plugins">` first: before hydration (or
 * with JavaScript off) Enter submits it and the server renders the results.
 * Once hydrated it also searches as you type — debounced, updating the URL with
 * `router.replace` so the address bar is always the shareable query — and `/`
 * anywhere on the page focuses it.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/router';
import { Search } from 'lucide-react';
import { DIRECTORY_QUERY_KEYS, directoryHref, withParam, type DirectoryQuery } from '@/lib/public-directory/query';

export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_INPUT_ID = 'plugin-search';

/** True when a keypress target is somewhere the user is typing. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

interface Props {
  query: DirectoryQuery;
  /** Update results while typing (the /plugins page). Off where a keystroke
   *  would navigate to a different page and drop focus (category pages). */
  live?: boolean;
}

export function DirectorySearch({ query, live = true }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(query.q ?? '');
  const committed = query.q ?? '';
  // Latest query in a ref, so the debounce effect doesn't re-arm on every render.
  const queryRef = useRef(query);
  queryRef.current = query;

  // Adopt the URL's `q` when it changes from outside (back/forward, a facet
  // link) — but not when it's just our own debounced commit catching up, which
  // would eat the trailing space of a half-typed "foo ".
  useEffect(() => { setValue((v) => (v.trim() === committed ? v : committed)); }, [committed]);

  // `/` focuses the box from anywhere that isn't already a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Debounced as-you-type search: the URL is the query.
  useEffect(() => {
    if (!live) return;
    const next = value.trim();
    if (next === committed) return;
    const timer = setTimeout(() => {
      void router.replace(directoryHref(withParam(queryRef.current, 'q', next || undefined)), undefined, { scroll: false });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, committed, live, router]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void router.push(directoryHref(withParam(query, 'q', value.trim() || undefined)));
  };

  // Every other active filter rides along as a hidden field, so the no-JS submit
  // keeps them. The cursor never does: a new query starts from the first page.
  const hidden = DIRECTORY_QUERY_KEYS.filter((k) => k !== 'q' && k !== 'cursor' && query[k] !== undefined);

  return (
    <form role="search" aria-label="Plugins" method="get" action="/plugins" onSubmit={onSubmit} className="w-full">
      <label htmlFor={SEARCH_INPUT_ID} className="sr-only">Search plugins</label>
      <div className="relative flex items-center">
        <Search className="pointer-events-none absolute left-3 h-4 w-4 text-fg-subtle" aria-hidden="true" />
        <input
          ref={inputRef}
          id={SEARCH_INPUT_ID}
          type="search"
          name="q"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search plugins — e.g. terraform, snyk, slack"
          autoComplete="off"
          maxLength={200}
          aria-keyshortcuts="/"
          className="input w-full py-2.5 pl-9 pr-24"
        />
        <kbd className="pointer-events-none absolute right-20 hidden rounded border border-default px-1.5 text-xs text-fg-subtle sm:block" aria-hidden="true">/</kbd>
        <button type="submit" className="btn btn-primary absolute right-1 px-3 py-1.5 text-sm">Search</button>
      </div>
      {hidden.map((k) => <input key={k} type="hidden" name={k} value={String(query[k])} />)}
    </form>
  );
}
