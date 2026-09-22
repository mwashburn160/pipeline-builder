// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { highlightSegments } from '@/lib/public-directory/highlight';

/**
 * Renders a search-highlight string. Only `<mark>`/`</mark>` become elements;
 * everything else is React text (escaped). Without a highlight, `text` renders
 * verbatim — it is never parsed at all.
 */
export function Highlighted({ highlight, text }: { highlight?: string; text: string }) {
  if (!highlight) return <>{text}</>;
  return (
    <>
      {highlightSegments(highlight).map((seg, i) => (seg.marked
        ? <mark key={i} className="rounded-sm bg-warning-bg px-0.5 text-fg">{seg.text}</mark>
        : <span key={i}>{seg.text}</span>))}
    </>
  );
}
