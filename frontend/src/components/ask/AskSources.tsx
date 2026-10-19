// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { BookOpen, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import type { AskSource } from '@/lib/api/domains/ask';
import { HELP_TOPIC_BY_DOC } from '@/lib/help/generated/doc-map';
import { DOCS_SITE_URL } from '@/lib/public-directory/links';

/**
 * The documents an answer was grounded in, as links the reader can actually
 * follow.
 *
 * These used to render as plain text. The assistant's whole claim is that it
 * answers FROM the docs rather than from the model's memory, and the citations
 * backing that claim were unreachable — the server has always sent a `url`, and
 * the panel dropped it.
 *
 * Two destinations, in this order:
 *
 *   1. The IN-APP help topic generated from the same doc, when one exists.
 *      Preferred because the reader stays in the dashboard, beside the answer
 *      and the drawer they are working in. The join is `docs/<source.id>` →
 *      {@link HELP_TOPIC_BY_DOC}, which is generated from the same manifest as
 *      the topics, so it cannot drift from them.
 *   2. The published docs site, for a doc with no topic — the per-category
 *      plugin docs and the repo's own indexes. Jekyll serves these at
 *      `<path>.html`, and the server's `url` carries no extension.
 *
 * A source with neither stays plain text rather than becoming a dead link.
 *
 * `onNavigate` closes the drawer on an in-app hop: leaving it open would park a
 * modal over the page the reader just asked to see.
 */
export function AskSources({ sources, onNavigate }: { sources: AskSource[]; onNavigate: () => void }) {
  if (sources.length === 0) return null;
  const row = 'flex items-center gap-1.5 text-xs text-fg-muted hover:text-brand transition-colors';

  return (
    <div className="mt-2 pt-2 border-t border-default space-y-1">
      <p className="text-2xs uppercase tracking-wide text-fg-muted">Sources</p>
      {sources.map((s) => {
        const topic = HELP_TOPIC_BY_DOC[`docs/${s.id}`];
        const label = s.title ?? topic?.title ?? s.id;

        if (topic) {
          return (
            <Link key={s.id} href={`/dashboard/help#topic-${topic.id}`} onClick={onNavigate} className={row}>
              <BookOpen className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{label}</span>
            </Link>
          );
        }
        if (s.url) {
          return (
            <a
              key={s.id}
              href={`${DOCS_SITE_URL}/${s.url}.html`}
              target="_blank"
              rel="noopener noreferrer"
              className={row}
            >
              <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{label}</span>
              <span className="sr-only">(opens the documentation site in a new tab)</span>
            </a>
          );
        }
        return <div key={s.id} className="text-xs text-fg-muted">{label}</div>;
      })}
    </div>
  );
}
