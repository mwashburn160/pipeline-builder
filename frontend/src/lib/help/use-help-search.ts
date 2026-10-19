// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react';
import { loadHelpGroups, type HelpTopicGroup } from '.';
import { searchHelp, type HelpSearchResult } from './search';
import { useHelpSearchMiss } from './use-search-miss';

export interface HelpSearch {
  /** Categories with their topics, or null while the corpus chunk is arriving. */
  groups: HelpTopicGroup[] | null;
  /** Every topic, flattened. Empty until the corpus lands. */
  topics: HelpSearchResult['topic'][];
  /** Ranked matches for the current query; empty for an empty query. */
  results: HelpSearchResult[];
  /** Whether to show results instead of the category browse. */
  searching: boolean;
  /** False while the corpus is still loading. */
  ready: boolean;
}

/**
 * Load the help corpus and search it.
 *
 * Both surfaces that render help topics — the Help page and the Ask drawer's
 * fallback view — need the same five things, and had grown their own copies of
 * all of them: the load effect with its `alive` guard, the flatten, the
 * `searchHelp` memo, the "is the reader searching" flag, and the miss
 * reporting. Two copies of a load effect is how one of them quietly keeps a
 * `setState` after unmount, or forgets to gate miss reporting on the corpus
 * having arrived — which would count a slow chunk as a gap in the docs.
 *
 * The corpus is ~1 MB of generated source behind a dynamic import, so it is
 * fetched on mount rather than imported at module scope: the caller paints its
 * search box immediately and the topics arrive into skeletons.
 *
 * @param query - The current search text, owned by the caller (the Help page
 *   mirrors it into the URL; the drawer keeps it local).
 */
export function useHelpSearch(query: string): HelpSearch {
  const [groups, setGroups] = useState<HelpTopicGroup[] | null>(null);

  useEffect(() => {
    let alive = true;
    void loadHelpGroups().then((g) => { if (alive) setGroups(g); });
    return () => { alive = false; };
  }, []);

  const topics = useMemo(() => (groups ?? []).flatMap((g) => g.topics), [groups]);
  const results = useMemo(() => searchHelp(topics, query), [topics, query]);
  const ready = groups !== null;

  // Gated on `ready`: while the corpus is still arriving every query matches
  // nothing, and reporting that would blame the docs for a slow network.
  useHelpSearchMiss(query, results.length, ready);

  return { groups, topics, results, searching: query.trim().length > 0, ready };
}
