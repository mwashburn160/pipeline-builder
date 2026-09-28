// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The HTML a report PDF is printed from.
 *
 * Tested as a STRING rather than through a browser, on purpose: what can go wrong here is
 * content, not layout — an unescaped note, a fact that exists only as a colour, a number
 * that is in the snapshot and not in the document. A headless-Chromium test would be slow,
 * would need a 150MB binary in CI, and would still not tell us any of those things.
 *
 * Four properties are load-bearing:
 *
 *  - ESCAPING. The snapshot carries org-written text into markup. A lead's notes that can
 *    close a tag can rewrite the rest of the report, which is document forgery in a file
 *    people make decisions from.
 *  - NO EXTERNAL REFERENCES. The renderer prints this with the network off, so anything
 *    fetched would render missing or hang. It is also the property that keeps the PDF path
 *    from becoming an SSRF surface.
 *  - NOTHING CARRIED BY COLOUR OR A GLYPH ALONE (WCAG 1.4.1 / 1.1.1). A locked panel and a
 *    downward trend both have to be readable as words.
 *  - ORDER. The lead's words come before the numbers, the same way the shared page does it.
 */

import { describe, it, expect } from '@jest/globals';
import type { ComposedSection, ReportSnapshot } from '../src/api/reporting/stakeholder/compose.js';
import {
  renderReportHtml, reportFileName, trendSentence,
} from '../src/api/reporting/stakeholder/report-html.js';

function snapshot(over: Partial<ReportSnapshot> = {}): ReportSnapshot {
  return {
    period: { start: '2026-09-14T00:00:00Z', end: '2026-09-21T00:00:00Z', label: '2026-W38' },
    previousPeriod: { start: '2026-09-07T00:00:00Z', end: '2026-09-14T00:00:00Z' },
    timezone: 'UTC',
    weekStart: 'monday',
    sections: [],
    notes: [],
    methodology: 'Computed over the window shown, from the same queries the dashboard uses.',
    generatedAt: '2026-09-21T06:00:00Z',
    ...over,
  };
}

function input(over: Partial<Parameters<typeof renderReportHtml>[0]> = {}) {
  return {
    title: 'Platform delivery',
    periodLabel: '2026-W38',
    periodStart: '2026-09-14T00:00:00Z',
    periodEnd: '2026-09-21T00:00:00Z',
    version: 1,
    publishedAt: '2026-09-21T08:00:00Z',
    snapshot: snapshot(),
    renderedAt: '2026-09-27T10:00:00Z',
    ...over,
  };
}

const ok = (over: Partial<ComposedSection> = {}): ComposedSection => ({
  id: 'success_rate',
  title: 'Build success rate',
  state: 'ok',
  headline: { label: 'Success rate', value: 91, unit: '%' },
  ...over,
});

describe('escaping every interpolation', () => {
  it('neutralises markup in a lead\'s notes', () => {
    const html = renderReportHtml(input({
      leadNotes: 'We paused deploys <script>alert(1)</script> on Tuesday',
    }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('neutralises markup in a section title, which comes from the registry but prints org data', () => {
    const html = renderReportHtml(input({
      snapshot: snapshot({ sections: [ok({ title: 'Pipeline "</td></tr><tr><td>injected' })] }),
    }));
    // The give-away would be a real closing tag appearing from the DATA rather than from
    // the template: the row count would change and the table would be rewritten below it.
    expect(html).not.toContain('</td></tr><tr><td>injected');
    expect(html).toContain('&lt;/td&gt;');
  });

  it('escapes the title, which reaches both the <title> element and the heading', () => {
    const html = renderReportHtml(input({ title: 'A & B <b>' }));
    expect(html).toContain('A &amp; B &lt;b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('escapes a data-quality note', () => {
    const html = renderReportHtml(input({
      snapshot: snapshot({ notes: [{ code: 'low_sample', message: '<img src=x onerror=1>' }] }),
    }));
    expect(html).not.toContain('<img src=x');
  });
});

describe('the document is self-contained', () => {
  const html = renderReportHtml(input({
    leadNotes: 'A note', snapshot: snapshot({ sections: [ok()] }),
  }));

  it('loads no script', () => {
    expect(html).not.toMatch(/<script/i);
  });

  it('references no external URL at all', () => {
    // The renderer prints this with the page offline and every request aborted, so a URL
    // here is at best a missing asset and at worst a hang. Checked as "no protocol
    // anywhere" rather than per-tag, because the next way someone adds one will not be a
    // tag we thought of — a CSS `url()`, an SVG `xlink:href`, a `@font-face`.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/url\(/i);
  });

  it('declares a content-security policy that permits nothing but its own inline style', () => {
    expect(html).toContain("default-src 'none'");
  });
});

describe('nothing is carried by colour or a bare glyph', () => {
  it('says a locked section is locked, in words, and names what it needs', () => {
    const html = renderReportHtml(input({
      snapshot: snapshot({
        sections: [{ id: 'dora', title: 'Deploys', state: 'locked', requiresFeature: 'advanced_reporting' }],
      }),
    }));
    expect(html).toContain('Not on your plan');
    expect(html).toContain('advanced_reporting');
    // And says the rest of the report still holds, or a reader treats the whole file as
    // suspect because one panel is empty.
    expect(html).toMatch(/rest of this report is unaffected/i);
  });

  it('says a failed section could not be computed, rather than showing a blank', () => {
    const html = renderReportHtml(input({
      snapshot: snapshot({ sections: [{ id: 'x', title: 'Plugin health', state: 'failed' }] }),
    }));
    expect(html).toMatch(/could not be computed/i);
  });

  it('writes the trend as a sentence, not an arrow', () => {
    const html = renderReportHtml(input({
      snapshot: snapshot({
        sections: [ok({ change: { absolute: -3, percent: -3.2, direction: 'down' } })],
      }),
    }));
    expect(html).toContain('down 3 points');
    // A glyph a screen reader either skips or reads as punctuation.
    expect(html).not.toMatch(/[▲▼↑↓]/);
  });

  it('says a section without a headline has none, rather than printing a bare dash alone', () => {
    const html = renderReportHtml(input({
      snapshot: snapshot({ sections: [{ id: 'breakdown', title: 'Pipeline breakdown', state: 'ok' }] }),
    }));
    expect(html).toMatch(/No single headline for this section/i);
  });
});

describe('trendSentence', () => {
  it('says nothing when the direction is unknown — a missing comparison is not "flat"', () => {
    expect(trendSentence(ok({ change: { absolute: 0, percent: null, direction: 'unknown' } }))).toBeNull();
  });

  it('says "unchanged" for flat, which is a real finding', () => {
    expect(trendSentence(ok({ change: { absolute: 0, percent: 0, direction: 'flat' } })))
      .toMatch(/unchanged/);
  });

  it('calls a percentage-point move POINTS, because "3% down from 91%" means something else', () => {
    const s = trendSentence(ok({ change: { absolute: -3, percent: -3.2, direction: 'down' } }));
    expect(s).toContain('down 3 points');
  });

  it('omits the unit for a plain count', () => {
    const s = trendSentence(ok({
      headline: { label: 'Deploys', value: 12 },
      change: { absolute: 4, percent: 50, direction: 'up' },
    }));
    expect(s).toBe('up 4 (+50%) from the previous period');
  });

  it('drops the percentage when there is none to state', () => {
    const s = trendSentence(ok({
      headline: { label: 'Deploys', value: 12 },
      change: { absolute: 4, percent: null, direction: 'up' },
    }));
    expect(s).toBe('up 4 from the previous period');
  });
});

describe('structure a screen reader can navigate', () => {
  const html = renderReportHtml(input({ snapshot: snapshot({ sections: [ok()] }) }));

  it('has exactly one h1', () => {
    expect(html.match(/<h1[ >]/g) ?? []).toHaveLength(1);
  });

  it('declares a language, so a screen reader picks the right voice', () => {
    expect(html).toContain('<html lang="en"');
  });

  it('gives the table a caption and column scopes, which is what becomes the PDF structure tree', () => {
    expect(html).toMatch(/<caption>/);
    expect(html).toContain('<th scope="col">');
    // The row header is what makes "Build success rate, 91%" one announcement instead of
    // two unrelated cells.
    expect(html).toContain('<th scope="row">');
  });
});

describe('order is meaning', () => {
  it('puts the lead\'s notes above the measures table', () => {
    const html = renderReportHtml(input({
      leadNotes: 'We paused deploys for the migration.',
      snapshot: snapshot({ sections: [ok()] }),
    }));
    expect(html.indexOf('We paused deploys')).toBeLessThan(html.indexOf('<table>'));
  });

  it('puts the executive summary above the measures and below the notes', () => {
    const html = renderReportHtml(input({
      leadNotes: 'Team note.',
      executiveSummary: 'Success rate held at 91%.',
      snapshot: snapshot({ sections: [ok()] }),
    }));
    expect(html.indexOf('Team note.')).toBeLessThan(html.indexOf('Success rate held at 91%.'));
    expect(html.indexOf('Success rate held at 91%.')).toBeLessThan(html.indexOf('<table>'));
  });

  it('splits free text on blank lines into separate paragraphs', () => {
    const html = renderReportHtml(input({ leadNotes: 'First para.\n\nSecond para.' }));
    expect(html).toContain('<p>First para.</p>');
    expect(html).toContain('<p>Second para.</p>');
  });
});

describe('the footer states what a reader would otherwise have to guess', () => {
  it('says names were replaced, when they were', () => {
    expect(renderReportHtml(input({ namesRedacted: true })))
      .toMatch(/names have been replaced/i);
  });

  it('says nothing about redaction when nothing was redacted', () => {
    expect(renderReportHtml(input())).not.toMatch(/names have been replaced/i);
  });

  it('gives a shared copy its link expiry, so a bookmark dying later is not a surprise', () => {
    expect(renderReportHtml(input({ expiresAt: '2026-10-21T00:00:00Z' })))
      .toContain('expires on 2026-10-21');
  });

  it('distinguishes when the figures were computed from when the file was made', () => {
    const html = renderReportHtml(input());
    expect(html).toContain('Figures computed 2026-09-21');
    expect(html).toContain('This file was created 2026-09-27');
  });

  it('carries the methodology, which is what makes a difference from the dashboard investigable', () => {
    expect(renderReportHtml(input())).toContain('from the same queries the dashboard uses');
  });
});

describe('degenerate runs still produce a document', () => {
  it('renders a null snapshot as a statement rather than an empty file', () => {
    const html = renderReportHtml(input({ snapshot: null }));
    // A zero-byte download looks like a broken feature; a file that says "nothing was
    // measured" looks like the answer it is.
    expect(html).toMatch(/Nothing was measured/i);
    expect(html).toContain('</html>');
  });

  it('renders a snapshot with no sections the same way', () => {
    expect(renderReportHtml(input({ snapshot: snapshot({ sections: [] }) })))
      .toMatch(/No measures/i);
  });

  it('shows a dash for an unparseable date instead of "Invalid Date"', () => {
    expect(renderReportHtml(input({ publishedAt: 'not-a-date' }))).not.toContain('Invalid Date');
  });

  it('marks a regeneration as a revision, so two copies of one period are tellable apart', () => {
    expect(renderReportHtml(input({ version: 3 }))).toContain('revision 3');
    expect(renderReportHtml(input({ version: 1 }))).not.toContain('revision');
  });

  it('omits the published line for a draft rather than printing an empty one', () => {
    expect(renderReportHtml(input({ publishedAt: null }))).not.toMatch(/published/);
  });

  it('shows a dash for a missing period bound instead of the word "null"', () => {
    const html = renderReportHtml(input({ periodStart: '' }));
    expect(html).toContain('—');
    expect(html).not.toMatch(/\bnull\b/);
  });

  it('names a locked section\'s requirement generically when the snapshot did not say', () => {
    // `requiresFeature` is optional on the type, so a section can arrive locked without
    // naming its feature. "Needs an add-on" is still actionable; "needs undefined" is not.
    const html = renderReportHtml(input({
      snapshot: snapshot({ sections: [{ id: 'dora', title: 'Deploys', state: 'locked' }] }),
    }));
    expect(html).toContain('needs an add-on');
    expect(html).not.toMatch(/undefined/);
  });

  it('prints a unitless headline without a trailing "undefined"', () => {
    const html = renderReportHtml(input({
      snapshot: snapshot({ sections: [ok({ headline: { label: 'Deploys', value: 12 } })] }),
    }));
    expect(html).toContain('>12</td>');
    expect(html).not.toMatch(/undefined/);
  });

  it('renders an empty-string note as nothing rather than as the string "null"', () => {
    // `esc` takes unknown and is reached with absent values through several paths; this
    // pins the one that a caller can actually produce.
    const html = renderReportHtml(input({ leadNotes: '', executiveSummary: '' }));
    expect(html).not.toMatch(/Notes from the team|Executive summary/);
  });
});

describe('reportFileName', () => {
  it('names the file after the period, because it is being filed next to last month\'s', () => {
    expect(reportFileName('Platform delivery', '2026-W38', 1)).toBe('Platform delivery 2026-W38.pdf');
  });

  it('carries the version only when there is more than one', () => {
    expect(reportFileName('Platform delivery', '2026-W38', 2)).toBe('Platform delivery 2026-W38 v2.pdf');
  });

  it('leaves sanitizing to the header helper rather than doing it twice', () => {
    // Two sanitizers means one of them gets a fix the other does not. This returns the
    // words; `attachmentDisposition` makes them header-safe.
    expect(reportFileName('A/B "test"', '2026-W38', 1)).toContain('A/B "test"');
  });
});
