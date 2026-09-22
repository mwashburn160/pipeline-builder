// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What the directory tells crawlers. The directory home and each category page
 * are the indexable pages; every search / facet / sort / later page is a view of
 * one (noindex, follow — links still crawled) whose canonical names that page.
 * And robots.txt keeps crawlers out of the app and points at the sitemap.
 */

import { describe, it, expect } from '@jest/globals';
import { directorySeo } from '../src/lib/public-directory/query';
import { renderRobots } from '../src/lib/public-directory/robots';

describe('directorySeo', () => {
  it('indexes the directory home', () => {
    expect(directorySeo({})).toEqual({ canonicalPath: '/plugins', noindex: false });
  });

  it('points a bare category filter at the category page, indexable there', () => {
    expect(directorySeo({ category: 'security' })).toEqual({ canonicalPath: '/plugins/category/security', noindex: false });
  });

  it.each([
    [{ q: 'trivy' }],
    [{ tier: 'official' as const }],
    [{ license: 'MIT' }],
    [{ minRating: '4' }],
    [{ sort: 'updated' as const }],
    [{ cursor: 'abc' }],
  ])('does not index %j, canonicalising to /plugins', (query) => {
    expect(directorySeo(query)).toEqual({ canonicalPath: '/plugins', noindex: true });
  });

  it('a facet within a category canonicalises to that category', () => {
    expect(directorySeo({ category: 'security', tier: 'official' })).toEqual({ canonicalPath: '/plugins/category/security', noindex: true });
  });
});

describe('robots.txt', () => {
  it('keeps crawlers out of the app and names the absolute sitemap', () => {
    const txt = renderRobots('https://pb.example');
    expect(txt).toMatch(/^Disallow: \/dashboard$/m);
    expect(txt).toMatch(/^Disallow: \/api\/$/m);
    expect(txt).toMatch(/^Sitemap: https:\/\/pb\.example\/sitemap\.xml$/m);
    expect(txt).not.toMatch(/^Disallow: \/plugins$/m);
  });
});
