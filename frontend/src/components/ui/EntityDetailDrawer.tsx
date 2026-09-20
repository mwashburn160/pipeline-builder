// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { DependencyList, ReactNode } from 'react';
import { DescriptionList, type DescriptionItem } from '@/components/ui/DescriptionList';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { SideDrawer } from '@/components/ui/SideDrawer';
import { useFetch } from '@/hooks/useFetch';
import { formatError } from '@/lib/constants';

interface EntityDetailDrawerProps<T> {
  /** Reads the entity fresh by id — never a row handed down from a list. */
  fetch: (signal: AbortSignal) => Promise<T | null>;
  /** What identity the fetch is keyed on (the id, plus any reload counter). */
  deps: DependencyList;
  ariaLabel: string;
  /** Heading shown while loading / on error, before the entity is known. */
  fallbackTitle: string;
  title: (entity: T) => ReactNode;
  subtitle?: (entity: T) => ReactNode;
  /** The key/value body. */
  items: (entity: T) => DescriptionItem[];
  /** Anything below the list (extra sections, tables). */
  children?: (entity: T) => ReactNode;
  /** Shown when the fetch fails and the error carries no message of its own. */
  errorMessage: string;
  loadingLabel?: string;
  onClose: () => void;
}

/**
 * A detail side-drawer that reads one entity by id and renders it as a
 * key/value list: fetch → error-with-retry → spinner → content.
 *
 * That twelve-line ceremony was copy-pasted per drawer (discounts, promotions,
 * service accounts), each with its own spelling of the loading and error
 * branches. Callers now supply only what differs — how to fetch, what to call
 * it, and what rows to show.
 */
export function EntityDetailDrawer<T>({
  fetch,
  deps,
  ariaLabel,
  fallbackTitle,
  title,
  subtitle,
  items,
  children,
  errorMessage,
  loadingLabel,
  onClose,
}: EntityDetailDrawerProps<T>) {
  // `deps` IS the caller's dependency list — the identity the entity is keyed
  // on. `fetch` deliberately isn't in it: it is re-read on every deps change,
  // which is `useFetch`'s own contract at every other call site.
  const { data, loading, error, refetch } = useFetch(fetch, deps);

  return (
    <SideDrawer
      title={data ? title(data) : fallbackTitle}
      subtitle={data && subtitle ? subtitle(data) : undefined}
      onClose={onClose}
      ariaLabel={ariaLabel}
    >
      {error ? (
        // `formatError` returns an Error's own message even when it is empty,
        // which would render a blank banner; `|| errorMessage` keeps the
        // fallback for that case (as the service-account drawer already did).
        <RetryError message={formatError(error, errorMessage) || errorMessage} onRetry={refetch} />
      ) : loading || !data ? (
        <LoadingSpinner label={loadingLabel} />
      ) : children ? (
        <div className="space-y-6">
          <DescriptionList items={items(data)} />
          {children(data)}
        </div>
      ) : (
        <DescriptionList items={items(data)} />
      )}
    </SideDrawer>
  );
}
