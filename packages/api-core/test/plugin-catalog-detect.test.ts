// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for validation/plugin-catalog-detect — catalog metadata DETECTED from the
 * package (spec → README → the plugin's own Dockerfile labels), then ACCEPTED
 * OR EDITED.
 */

import { describe, it, expect } from '@jest/globals';
import {
  acceptAllCatalogMetadata, detectCatalogMetadata, firstSentence, parseCatalogEdits, parseCatalogEditsPart,
  readmeFirstParagraph, readmeTitle, resolveCatalogMetadata, stripInlineMarkdown, type CatalogSpecFields, type DetectedField,
} from '../src/validation/plugin-catalog-detect.js';

const spec = (s: Record<string, unknown> = {}): CatalogSpecFields => ({ ...s } as CatalogSpecFields);

const byField = (fields: DetectedField[]) => Object.fromEntries(fields.map((f) => [f.field, f]));

const DOCKERFILE = [
  'FROM alpine',
  'LABEL org.opencontainers.image.title="Trivy (image)" \\',
  '      org.opencontainers.image.description="Label description. Second sentence." \\',
  '      org.opencontainers.image.licenses="MIT OR Apache-2.0" \\',
  '      org.opencontainers.image.url=https://trivy.dev \\',
  '      org.opencontainers.image.source=https://github.com/aquasecurity/trivy \\',
  '      org.opencontainers.image.documentation=https://bit.ly/docs',
].join('\n');

const README = [
  '# **Trivy** Scanner',
  '',
  '[![build](https://img.shields.io/b.svg)](https://ci)',
  '',
  'Scans container images for [known CVEs](https://nvd.nist.gov) and `misconfigurations`. It is fast.',
  'Second line of the paragraph.',
  '',
  '## Usage',
].join('\n');

describe('README reading', () => {
  it('finds the first level-1 heading as plain text, ignoring fenced code', () => {
    expect(readmeTitle(README)).toBe('Trivy Scanner');
    expect(readmeTitle('```\n# not a title\n```\n## sub\n# Real')).toBe('Real');
    expect(readmeTitle('no heading')).toBeNull();
    expect(readmeTitle('# ![badge](x)')).toBeNull();
  });

  it('finds the first prose paragraph, skipping headings, badges, lists, quotes and HTML', () => {
    expect(readmeFirstParagraph(README)).toBe(
      'Scans container images for known CVEs and misconfigurations. It is fast. Second line of the paragraph.',
    );
    expect(readmeFirstParagraph('# T\n- a list\n> quote\n<div>x</div>\n\nText here.')).toBe('Text here.');
    expect(readmeFirstParagraph('# Only a title')).toBeNull();
  });

  it('strips inline markdown', () => {
    expect(stripInlineMarkdown('**bold** _em_ `code` [link](u) ![img](i) <b>h</b>')).toBe('bold em code link h');
  });
});

describe('firstSentence', () => {
  it('cuts at the first sentence end', () => {
    expect(firstSentence('Scans images. Then more.')).toBe('Scans images.');
    expect(firstSentence('v1.2 is out! Great')).toBe('v1.2 is out!');
    expect(firstSentence('No terminal punctuation')).toBe('No terminal punctuation');
    expect(firstSentence('   ')).toBeNull();
  });

  it('shortens an over-long sentence on a word boundary with an ellipsis (≤ 160)', () => {
    const long = `${'word '.repeat(60)}end.`;
    const out = firstSentence(long)!;
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/ …$/);
    expect(firstSentence('x'.repeat(200))!.length).toBe(160);
  });
});

describe('detectCatalogMetadata — precedence (spec → README → Dockerfile)', () => {
  it('prefers the spec, then README, then the Dockerfile, field by field', () => {
    const f = byField(detectCatalogMetadata({
      spec: spec({ description: 'Spec description. More.', license: 'Apache-2.0', keywords: ['sca', 'cve'], category: 'security' }),
      readmeMd: README,
      dockerfileContent: DOCKERFILE,
    }));
    expect(f.description).toEqual({ field: 'description', value: 'Spec description. More.', source: 'spec', error: null });
    expect(f.summary).toEqual({ field: 'summary', value: 'Spec description.', source: 'derived', error: null });
    expect(f.displayName).toMatchObject({ value: 'Trivy Scanner', source: 'readme' });
    expect(f.license).toMatchObject({ value: 'Apache-2.0', source: 'spec' });
    expect(f.homepageUrl).toMatchObject({ value: 'https://trivy.dev', source: 'dockerfile' });
    expect(f.sourceUrl).toMatchObject({ value: 'https://github.com/aquasecurity/trivy', source: 'dockerfile' });
    expect(f.category).toMatchObject({ value: 'security', source: 'spec' });
    expect(f.keywords).toMatchObject({ value: ['sca', 'cve'], source: 'spec' });
    expect(f.readme).toMatchObject({ value: README, source: 'readme' });
  });

  it('falls back to the README first paragraph, then the Dockerfile description', () => {
    expect(byField(detectCatalogMetadata({ spec: spec(), readmeMd: README, dockerfileContent: DOCKERFILE })).description)
      .toMatchObject({ source: 'readme', value: expect.stringMatching(/^Scans container images/) });
    const fromLabel = byField(detectCatalogMetadata({ spec: spec(), readmeMd: null, dockerfileContent: DOCKERFILE }));
    expect(fromLabel.description).toMatchObject({ source: 'dockerfile', value: 'Label description. Second sentence.' });
    expect(fromLabel.summary).toMatchObject({ source: 'derived', value: 'Label description.' });
    expect(fromLabel.displayName).toMatchObject({ source: 'dockerfile', value: 'Trivy (image)' });
  });

  it('shows a detected value that fails the shared validator BLANK WITH THE REASON', () => {
    const f = byField(detectCatalogMetadata({ spec: spec({ category: 'build', keywords: Array(11).fill('k') }), readmeMd: null, dockerfileContent: DOCKERFILE }));
    // An SPDX expression is not one allowed id.
    expect(f.license).toMatchObject({ value: null, source: 'dockerfile', error: expect.stringMatching(/SPDX/) });
    // Shorteners are refused.
    expect(f.documentationUrl).toMatchObject({ value: null, source: 'dockerfile', error: expect.stringMatching(/shortener/) });
    expect(f.category).toMatchObject({ value: null, source: 'spec', error: expect.stringMatching(/one of/) });
    expect(f.keywords).toMatchObject({ value: null, source: 'spec', error: expect.stringMatching(/at most 10/) });
  });

  it('uses a spec summary over a derived one, and reports nothing found as null/null', () => {
    const f = byField(detectCatalogMetadata({ spec: spec({ summary: 'Own one-liner', icon: 'trivy' }), readmeMd: null, dockerfileContent: null }));
    expect(f.summary).toMatchObject({ value: 'Own one-liner', source: 'spec' });
    expect(f.icon).toMatchObject({ value: { key: 'trivy' }, source: 'spec' });
    expect(f.homepageUrl).toEqual({ field: 'homepageUrl', value: null, source: null, error: null });
    expect(f.readme).toEqual({ field: 'readme', value: null, source: null, error: null });
  });

  it('refuses an oversized README as blank-with-reason rather than failing the upload', () => {
    const f = byField(detectCatalogMetadata({ spec: spec(), readmeMd: `# T\n\n${'x'.repeat(70 * 1024)}`, dockerfileContent: null }));
    expect(f.readme).toMatchObject({ value: null, source: 'readme', error: expect.stringMatching(/bytes/) });
  });

  it('returns every descriptive field in display order', () => {
    expect(detectCatalogMetadata({ spec: spec(), readmeMd: null, dockerfileContent: null }).map((f) => f.field)).toEqual([
      'displayName', 'summary', 'description', 'category', 'keywords', 'license',
      'homepageUrl', 'sourceUrl', 'documentationUrl', 'icon', 'changelog', 'readme',
    ]);
  });
});

describe('resolveCatalogMetadata — accept or edit', () => {
  const detected = detectCatalogMetadata({
    spec: spec({ description: 'Spec description. More.', license: 'MIT', category: 'security' }),
    readmeMd: README,
    dockerfileContent: DOCKERFILE,
  });

  it('accepts every valid detected value with its source; invalid ones are not stored', () => {
    const { values, sources } = acceptAllCatalogMetadata(detected);
    expect(values.license).toBe('MIT');
    expect(values.documentationUrl).toBeNull();
    expect(sources).toEqual({
      displayName: 'readme',
      summary: 'derived',
      description: 'spec',
      category: 'spec',
      license: 'spec',
      homepageUrl: 'dockerfile',
      sourceUrl: 'dockerfile',
      readme: 'readme',
    });
  });

  it('records user edits (null clears) as `user` and re-derives a derived summary from an edited description', () => {
    const { values, sources } = resolveCatalogMetadata(detected, { description: 'Typed by me. Rest.', homepageUrl: null, license: 'Apache-2.0' });
    expect(values.description).toBe('Typed by me. Rest.');
    expect(values.summary).toBe('Typed by me.');
    expect(sources.summary).toBe('derived');
    expect(values.homepageUrl).toBeNull();
    expect(sources).toMatchObject({ description: 'user', homepageUrl: 'user', license: 'user' });
  });

  it('keeps an edited summary when the description is edited too', () => {
    const { values, sources } = resolveCatalogMetadata(detected, { summary: 'Mine.', description: 'Other.' });
    expect(values.summary).toBe('Mine.');
    expect(sources.summary).toBe('user');
  });

  it('keeps a SPEC summary when only the description is edited', () => {
    const d = detectCatalogMetadata({ spec: spec({ summary: 'From spec', description: 'Old.' }), readmeMd: null, dockerfileContent: null });
    const { values, sources } = resolveCatalogMetadata(d, { description: 'New.' });
    expect(values.summary).toBe('From spec');
    expect(sources.summary).toBe('spec');
  });

  it('lets the user supply a value where detection found nothing', () => {
    const d = detectCatalogMetadata({ spec: spec(), readmeMd: null, dockerfileContent: null });
    const { values, sources } = resolveCatalogMetadata(d, { description: 'Hello there. Bye.' });
    expect(values.summary).toBe('Hello there.');
    expect(sources).toEqual({ description: 'user', summary: 'derived' });
  });
});

describe('parseCatalogEdits / parseCatalogEditsPart', () => {
  it('accepts valid edits (normalizing an icon key) and treats an absent part as none', () => {
    expect(parseCatalogEditsPart(undefined)).toEqual({ ok: true, value: {} });
    expect(parseCatalogEditsPart('  ')).toEqual({ ok: true, value: {} });
    expect(parseCatalogEditsPart(JSON.stringify({ icon: 'trivy', summary: ' One. ', homepageUrl: null })))
      .toEqual({ ok: true, value: { icon: { key: 'trivy' }, summary: 'One.', homepageUrl: null } });
  });

  it('refuses execution-contract keys by name', () => {
    const r = parseCatalogEdits({ commands: ['x'], env: {}, summary: 'ok' });
    expect(r).toMatchObject({ ok: false, contractKeys: ['commands', 'env'] });
    expect(!r.ok && r.error).toMatch(/commands, env/);
  });

  it.each([
    ['not json', /valid JSON/],
    ['[1,2]', /JSON object/],
    ['"str"', /JSON object/],
    [JSON.stringify({ unknownField: 1 }), /Invalid metadata/],
    [JSON.stringify({ homepageUrl: 'http://x.io' }), /homepageUrl: must use https/],
    [JSON.stringify({ summary: 'x'.repeat(161) }), /summary/],
  ])('refuses %s', (text, reason) => {
    const r = parseCatalogEditsPart(text);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(reason);
  });
});
