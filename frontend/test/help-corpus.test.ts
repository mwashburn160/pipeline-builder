// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Guards the help corpus after the docs→help single-sourcing: every topic is
 * well-formed and renderable, ids are unique, and each GENERATED topic declares
 * the docs/*.md it came from (so the help↔docs link is explicit, not a silent
 * hand-copy). Regenerate with `npm run generate:help`.
 */
import { loadHelpGroups, loadHelpTopics, type HelpTopic, type HelpTopicGroup } from '../src/lib/help';

describe('help corpus', () => {
  // The corpus is a dynamic import (it is ~588 KB of generated source and must
  // not sit in the shared bundle), so every case loads it first. `loadHelpGroups`
  // memoizes, so this is one evaluation for the whole file.
  let HELP_TOPICS: HelpTopic[];
  let HELP_GROUPS: HelpTopicGroup[];
  beforeAll(async () => {
    [HELP_TOPICS, HELP_GROUPS] = await Promise.all([loadHelpTopics(), loadHelpGroups()]);
  });
  it('every topic is well-formed (id, title, icon, non-empty sections)', () => {
    for (const t of HELP_TOPICS) {
      expect(typeof t.id).toBe('string');
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.icon).toBeTruthy();
      expect(Array.isArray(t.sections)).toBe(true);
      expect(t.sections.length).toBeGreaterThan(0);
      // Every section has at least one content block.
      for (const s of t.sections) expect(s.blocks.length).toBeGreaterThan(0);
    }
  });

  it('topic ids are unique', () => {
    const ids = HELP_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('generated topics declare a docs/ source (the single source of truth)', () => {
    // The topics generated from docs carry `sourceDoc`; there must be several.
    const generated = HELP_TOPICS.filter((t) => t.sourceDoc);
    expect(generated.length).toBeGreaterThanOrEqual(10);
    for (const t of generated) expect(t.sourceDoc).toMatch(/^docs\/.+\.md$/);
  });

  it('every group topic is also in the flat list', () => {
    const flat = new Set(HELP_TOPICS.map((t) => t.id));
    for (const g of HELP_GROUPS) for (const t of g.topics) expect(flat.has(t.id)).toBe(true);
  });
});
