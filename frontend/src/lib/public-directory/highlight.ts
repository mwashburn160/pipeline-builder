// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Search match highlighting WITHOUT HTML injection.
 *
 * The API marks matches with literal `<mark>` / `</mark>` tags and nothing else.
 * Rather than trusting that, the string is split on exactly those two tokens and
 * every other character — including a `<script>` in a listing's summary — stays
 * text, which React escapes. So a highlight can make text bold; it can never
 * make markup.
 */
export interface HighlightSegment {
  text: string;
  marked: boolean;
}

export function highlightSegments(input: string): HighlightSegment[] {
  const out: HighlightSegment[] = [];
  let marked = false;
  for (const part of input.split(/(<mark>|<\/mark>)/)) {
    if (part === '<mark>') { marked = true; continue; }
    if (part === '</mark>') { marked = false; continue; }
    if (part) out.push({ text: part, marked });
  }
  return out;
}
