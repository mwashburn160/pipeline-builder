// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Help search behaviour. The page previously filtered topics with a single
 * substring test over the whole topic, which said "2 of 18 topics" and left the
 * reader to hunt for the hit inside a 2,000-line accordion. These tests pin the
 * properties that make a result actionable: section-level hits, a snippet, and
 * a ranking that puts a title match above a body match.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { Boxes } from 'lucide-react';
import { searchHelp, snippetAround, sectionText, blockText } from '../src/lib/help/search';
import { loadHelpTopics } from '../src/lib/help';
import type { HelpTopic } from '../src/lib/help/types';

const topic = (id: string, title: string, description: string, sections: HelpTopic['sections']): HelpTopic => ({
  id, title, description, icon: Boxes, sections,
});

const CORPUS: HelpTopic[] = [
  topic('alpha', 'Widget Deployment', 'How to deploy widgets', [
    { id: 's1', title: 'Overview', blocks: [{ type: 'text', content: 'Deploy a widget to production.' }] },
    { id: 's2', title: 'Troubleshooting', blocks: [{ type: 'text', content: 'If the sprocket jams, restart it.' }] },
  ]),
  topic('beta', 'Sprocket Reference', 'Every sprocket setting', [
    { id: 's1', title: 'Sprocket tuning', blocks: [{ type: 'text', content: 'Tune the widget carefully.' }] },
    { id: 's2', title: 'Limits', blocks: [{ type: 'table', headers: ['Key', 'Value'], rows: [['SPROCKET_MAX', '10']] }] },
  ]),
];

describe('searchHelp', () => {
  it('returns nothing for an empty query (browse view is the caller\'s job)', () => {
    expect(searchHelp(CORPUS, '')).toEqual([]);
    expect(searchHelp(CORPUS, '   ')).toEqual([]);
  });

  it('ranks a title match above a body-only match', () => {
    const results = searchHelp(CORPUS, 'sprocket');
    expect(results.map((r) => r.topic.id)).toEqual(['beta', 'alpha']);
    expect(results[0].where).toBe('title');
    expect(results[1].where).toBe('body');
  });

  it('reports WHICH sections matched, not just the topic', () => {
    const [result] = searchHelp(CORPUS, 'widget');
    // 'alpha' matches on title; its matching sections are still enumerated.
    const beta = searchHelp(CORPUS, 'widget').find((r) => r.topic.id === 'beta')!;
    expect(beta.sections.map((s) => s.section.id)).toEqual(['s1']);
    expect(result.sectionCount).toBeGreaterThan(0);
  });

  it('puts a section-heading hit before a body hit within one topic', () => {
    const [beta] = searchHelp(CORPUS, 'sprocket').filter((r) => r.topic.id === 'beta');
    expect(beta.sections[0].where).toBe('section');
    expect(beta.sections[0].section.id).toBe('s1');
  });

  it('searches inside table cells', () => {
    const results = searchHelp(CORPUS, 'SPROCKET_MAX');
    expect(results.map((r) => r.topic.id)).toContain('beta');
  });

  it('returns a snippet centred on the hit', () => {
    const [alpha] = searchHelp(CORPUS, 'jams');
    expect(alpha.sections[0].snippet).toContain('jams');
  });

  it('is case-insensitive', () => {
    expect(searchHelp(CORPUS, 'SPROCKET').length).toBe(searchHelp(CORPUS, 'sprocket').length);
  });

  it('finds nothing for a term absent from the corpus', () => {
    expect(searchHelp(CORPUS, 'zzzznope')).toEqual([]);
  });
});

describe('snippetAround', () => {
  it('collapses whitespace so code blocks and tables read as one line', () => {
    expect(snippetAround('a\n\n  b\tc', 'b')).toBe('a b c');
  });

  it('ellipsises both sides when the hit is deep inside a long text', () => {
    const long = `${'x'.repeat(400)} needle ${'y'.repeat(400)}`;
    const s = snippetAround(long, 'needle');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('needle');
    expect(s.length).toBeLessThan(long.length);
  });

  it('falls back to a leading excerpt when the term is absent', () => {
    expect(snippetAround('hello world', 'nope')).toBe('hello world');
  });
});

describe('against the real corpus', () => {
  // Dynamic import — the corpus is deliberately not in the shared bundle.
  let HELP_TOPICS: HelpTopic[];
  beforeAll(async () => { HELP_TOPICS = await loadHelpTopics(); });

  it('finds the AWS SES guidance the screenshot searched for', () => {
    const results = searchHelp(HELP_TOPICS, 'ses');
    expect(results.length).toBeGreaterThan(0);
    // Every result must carry something the reader can act on: either a
    // matching section, or a metadata match that explains itself.
    for (const r of results) {
      expect(r.sectionCount > 0 || r.where === 'title' || r.where === 'description').toBe(true);
    }
  });

  it('every section match carries a non-empty snippet', () => {
    for (const r of searchHelp(HELP_TOPICS, 'deploy')) {
      for (const s of r.sections) expect(s.snippet.length).toBeGreaterThan(0);
    }
  });
});

describe('block flattening', () => {
  it('covers every ContentBlock variant', () => {
    expect(blockText({ type: 'text', content: 'a' })).toBe('a');
    expect(blockText({ type: 'code', content: 'b' })).toBe('b');
    expect(blockText({ type: 'note', content: 'c' })).toBe('c');
    expect(blockText({ type: 'warning', content: 'd' })).toBe('d');
    expect(blockText({ type: 'list', items: ['e', 'f'] })).toBe('e f');
    expect(blockText({ type: 'table', headers: ['g'], rows: [['h']] })).toBe('g h');
  });

  it('sectionText includes the heading', () => {
    expect(sectionText({ id: 'x', title: 'Heading', blocks: [{ type: 'text', content: 'body' }] }))
      .toBe('Heading body');
  });
});
