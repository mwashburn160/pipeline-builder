// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers behind the public plugin directory: category data completeness,
 * the pipeline snippet, icon colours and monograms, match highlighting, the
 * query whitelist, and the SEO/sitemap escaping.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@/generated/plugin-icons', () => ({
  __esModule: true,
  PLUGIN_ICONS: {
    trivy: { url: '/plugin-icons/trivy.abc123.svg', hex: '#1904da', name: 'Trivy' },
    snyk: { url: '/plugin-icons/snyk.def456.svg', hex: null, name: null },
  },
}));

import {
  CATEGORY_DESCRIPTIONS, CATEGORY_DISPLAY_NAMES, CATEGORY_STAGES, PLUGIN_CATEGORIES, isPluginCategory,
} from '../src/lib/plugin-categories';
import { CATEGORY_ICONS } from '../src/lib/plugin-category-icons';
import { majorOf, pipelineSnippet, loginHref, safeExternalUrl, categoryDocUrl, pluginPagePath } from '../src/lib/public-directory/links';
import {
  MONOGRAM_PALETTE, contrastRatio, iconFills, monogramColor, monogramLetters,
} from '../src/lib/public-directory/icon-colors';
import { highlightSegments } from '../src/lib/public-directory/highlight';
import { directoryHref, isFilteredQuery, parseDirectoryQuery, withParam } from '../src/lib/public-directory/query';
import { renderSitemap } from '../src/lib/public-directory/sitemap';
import { pluginJsonLd, vendorDisclaimer } from '../src/lib/public-directory/listing';
import { detail } from './helpers/publicDirectoryFixtures';

describe('category data', () => {
  it('every category has a display name, description, stage and glyph', () => {
    for (const id of PLUGIN_CATEGORIES) {
      expect(CATEGORY_DISPLAY_NAMES[id]).toBeTruthy();
      expect(CATEGORY_DESCRIPTIONS[id].length).toBeGreaterThan(20);
      expect(CATEGORY_STAGES[id]).toBeTruthy();
      expect(CATEGORY_ICONS[id]).toBeTruthy();
    }
    expect(Object.keys(CATEGORY_DESCRIPTIONS).sort()).toEqual([...PLUGIN_CATEGORIES].sort());
    expect(Object.keys(CATEGORY_STAGES).sort()).toEqual([...PLUGIN_CATEGORIES].sort());
    expect(Object.keys(CATEGORY_ICONS).sort()).toEqual([...PLUGIN_CATEGORIES].sort());
  });

  it('descriptions carry no hard-coded plugin counts (counts are live)', () => {
    for (const id of PLUGIN_CATEGORIES) expect(CATEGORY_DESCRIPTIONS[id]).not.toMatch(/\d+\s+plugins/i);
  });

  it('isPluginCategory narrows only known ids', () => {
    expect(isPluginCategory('security')).toBe(true);
    expect(isPluginCategory('Security')).toBe(false);
    expect(isPluginCategory(undefined)).toBe(false);
  });

  it('links each category to its doc on GitHub', () => {
    expect(categoryDocUrl('security')).toBe('https://github.com/mwashburn160/pipeline-builder/blob/main/docs/plugins/security.md');
  });
});

describe('pipeline snippet', () => {
  it('omits the implicit pipeline-builder publisher', () => {
    expect(pipelineSnippet('pipeline-builder', 'trivy', '1.4.2')).toBe("plugin: { name: trivy, filter: { version: '^1' } }");
  });

  it('names any other publisher', () => {
    expect(pipelineSnippet('acme', 'x', '2.0.0')).toBe("plugin: { publisher: acme, name: x, filter: { version: '^2' } }");
  });

  it('drops the filter when the version is not semver-shaped', () => {
    expect(majorOf('latest')).toBeNull();
    expect(pipelineSnippet('acme', 'x', 'latest')).toBe('plugin: { publisher: acme, name: x }');
    expect(majorOf('v03.1.0')).toBe('3');
  });
});

describe('icon colours', () => {
  it('keeps a brand colour that clears 3:1 in both themes', () => {
    // Mid teal clears 3:1 against both white and the dark surface.
    const fills = iconFills('#1a9e8f');
    expect(fills.light).toBe('#1a9e8f');
    expect(fills.dark).toBe('#1a9e8f');
  });

  it('inverts a near-black mark to the text colour in dark mode', () => {
    const fills = iconFills('#181717'); // GitHub
    expect(fills.light).toBe('#181717');
    expect(fills.dark).toBe('var(--pb-text)');
  });

  it('falls back to the text colour for a pale mark on light, and for no colour at all', () => {
    expect(iconFills('#f7df1e').light).toBe('var(--pb-text)'); // JavaScript yellow on white
    expect(iconFills(null)).toEqual({ light: 'var(--pb-text)', dark: 'var(--pb-text)' });
    expect(iconFills('not-a-colour')).toEqual({ light: 'var(--pb-text)', dark: 'var(--pb-text)' });
  });
});

describe('monogram', () => {
  it('is deterministic', () => {
    expect(monogramColor('snyk-python')).toBe(monogramColor('snyk-python'));
    expect(monogramLetters('snyk-python')).toBe('SP');
    expect(monogramLetters('trivy')).toBe('TR');
    expect(monogramLetters('---')).toBe('?');
  });

  it('spreads names over the palette', () => {
    const colours = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((n) => monogramColor(`plugin-${n}`)));
    expect(colours.size).toBeGreaterThan(3);
  });

  it('every tile colour keeps white letters at AA contrast', () => {
    for (const c of MONOGRAM_PALETTE) expect(contrastRatio(c, '#ffffff')!).toBeGreaterThanOrEqual(4.5);
  });
});

describe('highlightSegments', () => {
  it('marks only <mark> spans', () => {
    expect(highlightSegments('run <mark>trivy</mark> scans')).toEqual([
      { text: 'run ', marked: false },
      { text: 'trivy', marked: true },
      { text: ' scans', marked: false },
    ]);
  });

  it('keeps every other tag as literal text', () => {
    const segs = highlightSegments('<script>alert(1)</script><mark><img src=x onerror=alert(1)></mark>');
    expect(segs).toEqual([
      { text: '<script>alert(1)</script>', marked: false },
      { text: '<img src=x onerror=alert(1)>', marked: true },
    ]);
  });
});

describe('directory query whitelist', () => {
  it('drops unknown keys and invalid values', () => {
    expect(parseDirectoryQuery({
      q: '  terraform   aws ', tier: 'godmode', sort: 'rating', evil: 'x', category: 'security',
      needsSecrets: 'maybe', minRating: '9', cursor: '<script>',
    })).toEqual({ q: 'terraform aws', category: 'security', sort: 'rating' });
  });

  it('takes the first of repeated params and bounds q', () => {
    expect(parseDirectoryQuery({ q: ['a', 'b'] }).q).toBe('a');
    expect(parseDirectoryQuery({ q: 'x'.repeat(500) }).q).toHaveLength(200);
  });

  it('builds canonical links and resets the cursor on any change', () => {
    const q = { q: 'snyk', cursor: 'abc' };
    expect(directoryHref(withParam(q, 'tier', 'official'))).toBe('/plugins?q=snyk&tier=official');
    expect(directoryHref(withParam(q, 'q', undefined))).toBe('/plugins');
    expect(isFilteredQuery({ sort: 'name' })).toBe(false);
    expect(isFilteredQuery({ tier: 'official' })).toBe(true);
  });
});

describe('links', () => {
  it('encodes the sign-in return path', () => {
    expect(loginHref('/plugins?q=a b&tier=official')).toBe('/login?returnTo=%2Fplugins%3Fq%3Da%20b%26tier%3Dofficial');
  });

  it('only renders same-origin paths or https URLs', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('http://example.com')).toBeNull();
    expect(safeExternalUrl('//evil.example')).toBeNull();
    expect(safeExternalUrl('/api/public/x')).toBe('/api/public/x');
    expect(safeExternalUrl('https://trivy.dev')).toBe('https://trivy.dev/');
  });

  it('encodes path segments', () => {
    expect(pluginPagePath('acme', 'a/b')).toBe('/plugins/acme/a%2Fb');
  });
});

describe('vendor disclaimer', () => {
  it('appears for a vendor logo on an Official listing', () => {
    expect(vendorDisclaimer(detail({ iconKind: 'vendor', iconKey: 'trivy' })))
      .toBe('Not affiliated with or endorsed by Trivy.');
  });

  it('is omitted when the Verified publisher is the vendor, for non-vendor icons, and for unknown keys', () => {
    expect(vendorDisclaimer(detail({
      iconKind: 'vendor', iconKey: 'trivy', publisher: { handle: 'aqua', displayName: 'Aqua', tier: 'verified' },
    }))).toBeNull();
    expect(vendorDisclaimer(detail({ iconKind: 'monogram' }))).toBeNull();
    expect(vendorDisclaimer(detail({ iconKind: 'vendor', iconKey: 'gone' }))).toBeNull();
  });

  it('derives a name from the key when SOURCES.md records none', () => {
    expect(vendorDisclaimer(detail({ iconKind: 'vendor', iconKey: 'snyk' }))).toBe('Not affiliated with or endorsed by Snyk.');
  });
});

describe('SEO output', () => {
  it('JSON-LD cannot close its <script> element', () => {
    const json = pluginJsonLd(detail({ summary: '</script><script>alert(1)</script>' }), 'https://x/plugins/p/n');
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json)).toMatchObject({ '@type': 'SoftwareApplication', name: 'trivy', softwareVersion: '1.4.2' });
  });

  it('adds aggregateRating only when rated', () => {
    expect(JSON.parse(pluginJsonLd(detail(), 'u')).aggregateRating).toBeUndefined();
    expect(JSON.parse(pluginJsonLd(detail({ rating: { score: 4.5, count: 10 } }), 'u')).aggregateRating)
      .toEqual({ '@type': 'AggregateRating', ratingValue: 4.5, ratingCount: 10 });
  });

  it('sitemap escapes XML', () => {
    const xml = renderSitemap([{ loc: 'https://x/plugins?a=1&b=2', lastmod: '2026-09-20T10:00:00Z' }]);
    expect(xml).toContain('<loc>https://x/plugins?a=1&amp;b=2</loc><lastmod>2026-09-20</lastmod>');
  });
});
