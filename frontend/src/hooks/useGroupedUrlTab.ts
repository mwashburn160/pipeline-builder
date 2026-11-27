// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { useRouter } from 'next/router';
import { useEventCallback } from './useLatest';
import {
  SECTION_KEY, resolveTabLocation, settleTabLocation, tabQuery,
  type GroupedTabsConfig, type TabLocation, type TabVisibility,
} from '@/lib/page-tabs/grouped';

interface GroupedUrlTabOptions<G extends string, S extends string> extends TabVisibility<G, S> {
  /** Query keys that belong to the view being left (a report's own `sub`), dropped on every switch. */
  clearOnSelect?: readonly string[];
}

/**
 * Two-level tab state in the URL (`?tab=` and `?section=`), for the pages whose
 * tabs are grouped (see `lib/page-tabs`).
 *
 * The location is read from the query on every render, so a link, a refresh and
 * Back all land where the URL says. A switch also holds the picked location
 * until the URL next moves, so the view changes at once, before the shallow
 * `replace` lands. Visibility narrows the result: a tab or sub-tab the viewer
 * may not open falls to the first one they may.
 */
export function useGroupedUrlTab<G extends string, S extends string>(
  config: GroupedTabsConfig<G, S>,
  options: GroupedUrlTabOptions<G, S> = {},
): { tab: G; section: S | null; select: (tab: G, section?: S) => void } {
  const router = useRouter();
  const rawTab = first(router.query.tab);
  const rawSection = first(router.query[SECTION_KEY]);
  const urlKey = `${rawTab ?? ''}\u0000${rawSection ?? ''}`;
  const [picked, setPicked] = useState<TabLocation<G, S> | null>(null);
  // Any URL move (the switch landing, Back, a link) ends the held pick, so Back
  // onto the URL the pick was made from shows that URL, not the pick.
  const [seenKey, setSeenKey] = useState(urlKey);
  const urlMoved = seenKey !== urlKey;
  if (urlMoved) {
    setSeenKey(urlKey);
    setPicked(null);
  }

  const requested = (!urlMoved && picked) || resolveTabLocation(config, rawTab, rawSection);
  const { tab, section } = settleTabLocation(config, requested, options);

  const select = useEventCallback((nextTab: G, nextSection?: S) => {
    const location: TabLocation<G, S> = { tab: nextTab, section: nextSection ?? null };
    setPicked(location);
    const query: Record<string, string | string[] | undefined> = { ...router.query };
    delete query[SECTION_KEY];
    for (const key of options.clearOnSelect ?? []) delete query[key];
    void router.replace({ query: { ...query, ...tabQuery(location) } }, undefined, { shallow: true });
  });

  return { tab, section, select };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
