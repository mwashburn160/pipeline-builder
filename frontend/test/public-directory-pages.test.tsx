// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Public plugin directory pages (`/plugins`, `/plugins/category/[c]`,
 * `/plugins/[publisher]/[name]`, `/sitemap.xml`).
 *
 * What matters: the server side calls the public API WITHOUT credentials and
 * marks good responses CDN-cacheable (and failures not); a disabled directory
 * (API 404) is a page 404; the SSR markup is the guest's (sign-in links, never
 * the viewer's identity); untrusted listing text renders inert; and the plugin
 * page carries the snippet, the right tabs and the vendor note.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, within } from '@testing-library/react';
import type { GetServerSidePropsContext } from 'next';
import { card, detail, fakeRes, jsonResponse, searchResult } from './helpers/publicDirectoryFixtures';

const replace = jest.fn<AnyFn>();
const push = jest.fn<AnyFn>();
let asPath = '/plugins';
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query: {}, asPath, pathname: '/plugins', push, replace })));

let authState: Record<string, unknown> = { user: null, isAuthenticated: false, isInitialized: true };
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => authState));
jest.mock('@/hooks/useDarkMode', () => ({ __esModule: true, useDarkMode: () => ({ isDark: false, toggle: () => undefined }) }));
jest.mock('@/generated/plugin-icons', () => ({
  __esModule: true,
  PLUGIN_ICONS: {
    trivy: { url: '/plugin-icons/trivy.abc123.svg', hex: '#1904da', name: 'Trivy' },
    python: { url: '/plugin-icons/python.fff000.svg', hex: '#3776ab', name: 'Python' },
  },
}));

import DirectoryPage, { getServerSideProps as directoryGssp, type DirectoryPageProps } from '../pages/plugins/index';
import CategoryPage, { getServerSideProps as categoryGssp, type CategoryPageProps } from '../pages/plugins/category/[category]';
import PluginPage, { getServerSideProps as pluginGssp, type PluginPageProps } from '../pages/plugins/[publisher]/[name]';
import { getServerSideProps as sitemapGssp } from '../pages/sitemap.xml';
import { PUBLIC_CACHE_CONTROL } from '../src/lib/public-directory/server';

const fetchMock = jest.fn<AnyFn>();
const realFetch = global.fetch;

beforeEach(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  asPath = '/plugins';
  authState = { user: null, isAuthenticated: false, isInitialized: true };
});
afterEach(() => { global.fetch = realFetch; });

function ctx(over: { query?: Record<string, string>; params?: Record<string, string> } = {}) {
  const res = fakeRes();
  const c = { query: over.query ?? {}, params: over.params ?? {}, res, req: { headers: { authorization: 'Bearer viewer-token', cookie: 'refresh=x' } } };
  return { c: c as unknown as GetServerSidePropsContext, res };
}

/** Every outgoing request: its URL and its headers. */
function calls() {
  return fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: (init ?? {}) as RequestInit }));
}

function expectNoCredentials() {
  expect(fetchMock).toHaveBeenCalled();
  for (const { url, init } of calls()) {
    expect(url).toMatch(/\/api\/public\/plugins/);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).not.toHaveProperty('x-org-id');
    expect(headers).not.toHaveProperty('cookie');
    expect(init.credentials).toBe('omit');
  }
}

describe('/plugins getServerSideProps', () => {
  it('home: fetches categories, featured Official and recent without credentials; cacheable', async () => {
    fetchMock.mockImplementation(async (url: unknown) => (String(url).includes('/categories')
      ? jsonResponse(200, { categories: [{ id: 'security', count: 3, top: [card()] }] })
      : jsonResponse(200, searchResult([card()]))));
    const { c, res } = ctx();
    const out = await directoryGssp(c);
    expect(out).toMatchObject({ props: { mode: 'home' } });
    expect(res.headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
    expect(PUBLIC_CACHE_CONTROL).toBe('public, s-maxage=60, stale-while-revalidate=600');
    expectNoCredentials();
    expect(calls().map((x) => x.url)).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/api\/public\/plugins\?tier=official&sort=installs&limit=6$/),
      expect.stringMatching(/\/api\/public\/plugins\?sort=updated&limit=6$/),
    ]));
  });

  it('results: forwards only whitelisted params', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, searchResult([card()])));
    const { c } = ctx({ query: { q: 'trivy', tier: 'official', evil: '1', sort: 'bogus' } });
    const out = await directoryGssp(c);
    expect(out).toMatchObject({ props: { mode: 'results', query: { q: 'trivy', tier: 'official' } } });
    expect(calls()[0].url).toMatch(/\/api\/public\/plugins\?q=trivy&tier=official&limit=24$/);
    expectNoCredentials();
  });

  it('404s when the directory is off (API 404)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404));
    expect(await directoryGssp(ctx({ query: { q: 'x' } }).c)).toEqual({ notFound: true });
    fetchMock.mockResolvedValue(jsonResponse(404));
    expect(await directoryGssp(ctx().c)).toEqual({ notFound: true });
  });

  it('an API failure is a 503 that is never cached', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500));
    const { c, res } = ctx({ query: { q: 'x' } });
    expect(await directoryGssp(c)).toMatchObject({ props: { mode: 'unavailable' } });
    expect(res.statusCode).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('a network error is also unavailable, not a crash', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await directoryGssp(ctx({ query: { q: 'x' } }).c)).toMatchObject({ props: { mode: 'unavailable' } });
  });
});

const baseProps = { siteUrl: 'https://pb.example', query: {} };

describe('/plugins page', () => {
  it('home renders the search landmark, category grid with live counts, and sections', () => {
    const props = {
      ...baseProps, mode: 'home', categories: [{ id: 'security', count: 7, top: [card()] }], featured: [card()], recent: [],
    } as DirectoryPageProps;
    render(<DirectoryPage {...props} />);
    const search = screen.getByRole('search', { name: 'Plugins' });
    expect(within(search).getByLabelText('Search plugins')).toHaveAttribute('name', 'q');
    expect(search).toHaveAttribute('method', 'get');
    expect(search).toHaveAttribute('action', '/plugins');
    expect(screen.getByRole('link', { name: 'Security' })).toHaveAttribute('href', '/plugins/category/security');
    expect(screen.getByText('7 plugins')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Featured Official plugins' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recently updated' })).toBeNull();
  });

  it('SSR header is the guest variant, with a sign-in link back to this query', () => {
    asPath = '/plugins?q=trivy';
    const props = { ...baseProps, query: { q: 'trivy' }, mode: 'results', results: searchResult([card()]) } as DirectoryPageProps;
    render(<DirectoryPage {...props} />);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?returnTo=%2Fplugins%3Fq%3Dtrivy');
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/auth/register');
  });

  it('a signed-in viewer sees Open app after mount', () => {
    authState = { user: { id: 'u1', username: 'dana', email: 'd@x' }, isAuthenticated: true, isInitialized: true };
    const props = { ...baseProps, mode: 'results', results: searchResult([card()]) } as DirectoryPageProps;
    render(<DirectoryPage {...props} />);
    expect(screen.getByRole('link', { name: 'Open app' })).toHaveAttribute('href', '/dashboard');
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });

  it('results announce the count and render highlight marks but never markup', () => {
    const evil = card({
      name: 'trivy',
      summary: '<script>alert(1)</script>',
      highlight: { name: '<mark>tri</mark>vy', summary: '<img src=x onerror=alert(1)><mark>scan</mark>' },
    });
    const props = { ...baseProps, query: { q: 'tri' }, mode: 'results', results: searchResult([evil]) } as DirectoryPageProps;
    const { container } = render(<DirectoryPage {...props} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 plugin for “tri”');
    expect(container.querySelectorAll('mark')).toHaveLength(2);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[onerror]')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it('unhighlighted summaries render verbatim as text', () => {
    const props = { ...baseProps, mode: 'results', results: searchResult([card({ summary: '<script>alert(1)</script>' })]) } as DirectoryPageProps;
    const { container } = render(<DirectoryPage {...props} />);
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
  });

  it('empty results offer category browse, Submit a plugin (no account) and a sign-in link', () => {
    asPath = '/plugins?q=zzz';
    const props = { ...baseProps, query: { q: 'zzz' }, mode: 'results', results: searchResult([]) } as DirectoryPageProps;
    render(<DirectoryPage {...props} />);
    expect(screen.getByRole('heading', { name: /No plugins match/ })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Browse by category' })).getAllByRole('link')).toHaveLength(10);
    expect(screen.getByRole('link', { name: 'Submit a plugin' })).toHaveAttribute('href', '/plugins/submit');
    expect(screen.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/login?returnTo=%2Fplugins%3Fq%3Dzzz');
  });

  it('facets are links that toggle a filter and keep the query', () => {
    const props = { ...baseProps, query: { q: 'scan' }, mode: 'results', results: searchResult([card()]) } as DirectoryPageProps;
    render(<DirectoryPage {...props} />);
    const filters = screen.getByRole('navigation', { name: 'Filters' });
    expect(within(filters).getByRole('link', { name: /No secrets needed/ })).toHaveAttribute('href', '/plugins?q=scan&needsSecrets=false');
    expect(screen.getByRole('navigation', { name: 'Sort' })).toBeInTheDocument();
  });

  it('pagination links carry the cursor', () => {
    const props = { ...baseProps, query: { q: 'a' }, mode: 'results', results: searchResult([card()], { nextCursor: 'c2' }) } as DirectoryPageProps;
    render(<DirectoryPage {...props} />);
    expect(screen.getByRole('link', { name: 'Next page →' })).toHaveAttribute('href', '/plugins?q=a&cursor=c2');
  });
});

describe('/plugins/category/[category]', () => {
  it('404s an unknown category without calling the API', async () => {
    expect(await categoryGssp(ctx({ params: { category: 'nope' } }).c)).toEqual({ notFound: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the category without credentials and is cacheable', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, searchResult([card()])));
    const { c, res } = ctx({ params: { category: 'security' }, query: { category: 'security', sort: 'name' } });
    expect(await categoryGssp(c)).toMatchObject({ props: { category: 'security', query: { sort: 'name' } } });
    expect(calls()[0].url).toMatch(/\/api\/public\/plugins\?category=security&sort=name&limit=48$/);
    expect(res.headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
    expectNoCredentials();
  });

  it('renders the description, where it fits, and the docs link', () => {
    const props: CategoryPageProps = { siteUrl: 'https://pb.example', category: 'security', query: {}, results: searchResult([card()]) };
    render(<CategoryPage {...props} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Security' })).toBeInTheDocument();
    expect(screen.getByText('Build · Test')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Security plugin docs/ }))
      .toHaveAttribute('href', 'https://docs.pipeline-builder.com/docs/plugins/security.html');
  });
});

describe('/plugins/[publisher]/[name]', () => {
  it('fetches the listing without credentials; 404 when not listed', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { listing: detail() }));
    const { c, res } = ctx({ params: { publisher: 'pipeline-builder', name: 'trivy' }, query: { tab: 'versions' } });
    expect(await pluginGssp(c)).toMatchObject({ props: { tab: 'versions', listing: { name: 'trivy' } } });
    expect(calls()[0].url).toMatch(/\/api\/public\/plugins\/pipeline-builder\/trivy$/);
    expect(res.headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
    expectNoCredentials();

    fetchMock.mockResolvedValue(jsonResponse(404));
    expect(await pluginGssp(ctx({ params: { publisher: 'x', name: 'y' } }).c)).toEqual({ notFound: true });
  });

  it('rejects malformed path segments before calling the API', async () => {
    expect(await pluginGssp(ctx({ params: { publisher: '../x', name: 'y' } }).c)).toEqual({ notFound: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders header, snippet, sign-in-to-install and the tabs (Reviews even before any rating)', () => {
    asPath = '/plugins/pipeline-builder/trivy';
    const props: PluginPageProps = { siteUrl: 'https://pb.example', listing: detail(), tab: 'overview' };
    render(<PluginPage {...props} />);
    expect(screen.getByRole('heading', { level: 1, name: 'trivy' })).toBeInTheDocument();
    expect(screen.getByText('Official')).toBeInTheDocument();
    expect(screen.getByText("plugin: { name: trivy, filter: { version: '^1' } }")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to install' }))
      .toHaveAttribute('href', '/login?returnTo=%2Fplugins%2Fpipeline-builder%2Ftrivy');
    const tabs = screen.getByRole('navigation', { name: 'Plugin details' });
    expect(within(tabs).getAllByRole('link').map((a) => a.textContent)).toEqual(['Overview', 'Versions', 'Configuration', 'Supply chain', 'Reviews']);
    expect(screen.getByTestId('readme').innerHTML).toBe('<h2>Trivy</h2><p>Scans images.</p>');
    expect(screen.queryByTestId('vendor-disclaimer')).toBeNull();
  });

  it('shows the rating distribution on Reviews, and the vendor note for a vendor icon', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { reviews: [], total: 0, nextCursor: null }));
    const listing = detail({
      iconKind: 'vendor', iconKey: 'trivy', iconBadge: 'python',
      rating: { score: 4.2, count: 12 }, ratingDistribution: { 1: 0, 2: 1, 3: 1, 4: 4, 5: 6 },
    });
    render(<PluginPage siteUrl="https://pb.example" listing={listing} tab="reviews" />);
    expect(within(screen.getByRole('navigation', { name: 'Plugin details' })).getByRole('link', { name: 'Reviews' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Rating distribution' })).toBeInTheDocument();
    // The review list loads in the browser from the anonymous API, credential-free.
    expect(await screen.findByText('No reviews yet.')).toBeInTheDocument();
    expect(calls()[0].url).toMatch(/\/api\/public\/plugins\/pipeline-builder\/trivy\/reviews\?sort=helpful&limit=10$/);
    expectNoCredentials();
    expect(screen.getByTestId('vendor-disclaimer')).toHaveTextContent('Not affiliated with or endorsed by Trivy.');
    const icon = screen.getByTestId('plugin-icon-vendor');
    expect(icon.querySelector('[data-icon-fill-light]')).toHaveAttribute('style', expect.stringContaining('/plugin-icons/trivy.abc123.svg'));
    expect(icon.querySelector('svg image, script')).toBeNull();
  });

  it('falls back to the monogram for a vendor key missing from the manifest', () => {
    render(<PluginPage siteUrl="https://pb.example" listing={detail({ iconKind: 'vendor', iconKey: 'dropped' })} tab="overview" />);
    expect(screen.getByTestId('plugin-monogram')).toHaveTextContent('TR');
  });

  it('shows advisory and unmaintained banners; changelog renders as text', () => {
    const listing = detail({
      state: 'unmaintained',
      advisories: [{ id: 'PBSA-1', severity: 'high', summary: 'RCE', affectedRange: '<1.4.3', fixedVersion: '1.4.3', publishedAt: '2026-09-20', detailsHtml: null, cveIds: [] }],
    });
    const { container } = render(<PluginPage siteUrl="https://pb.example" listing={listing} tab="versions" />);
    expect(screen.getByText('Active security advisory')).toBeInTheDocument();
    expect(screen.getByText('This plugin is unmaintained')).toBeInTheDocument();
    expect(screen.getByText('Fixes <b>things</b>')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
  });

  it('shows the health badge and a breakdown with reweighted signals', () => {
    const listing = detail({
      healthScore: 64,
      successRate30d: 0.9,
      healthBreakdown: {
        runtime: { score: 0.9, weight: 25 }, vulns: { score: 0.5, weight: 20 }, signed: { score: 1, weight: 10 },
        rating: { score: null, weight: 10 },
      },
    });
    render(<PluginPage siteUrl="https://pb.example" listing={listing} tab="overview" />);
    const badges = screen.getAllByText('Health 64');
    expect(badges[0]!.closest('[data-health-band]')).toHaveAttribute('data-health-band', 'fair');
    const panel = screen.getByTestId('health-breakdown');
    expect(within(panel).getByRole('table')).toBeInTheDocument();
    expect(within(panel).getByRole('meter', { name: 'Known vulnerabilities: 50 out of 100' })).toBeInTheDocument();
    expect(within(panel).getByText(/Fewer than 3 ratings — not counted/)).toBeInTheDocument();
    // runtime 25 of the 55 known weight.
    expect(within(panel).getByText('45%')).toBeInTheDocument();
    expect(within(panel).getByText('90% of runs succeeded in the last 30 days.')).toBeInTheDocument();
  });

  it('shows "not enough data" and no badge without a score', () => {
    render(<PluginPage siteUrl="https://pb.example" listing={detail({ healthScore: null, healthBreakdown: null })} tab="overview" />);
    expect(screen.queryByText(/^Health \d+/)).toBeNull();
    expect(within(screen.getByTestId('health-breakdown')).getByText('Not enough data yet')).toBeInTheDocument();
  });

  it('other publishers are named in the snippet', () => {
    const listing = detail({ publisher: { handle: 'acme', displayName: 'Acme', tier: 'community' }, latestVersion: '2.1.0' });
    render(<PluginPage siteUrl="https://pb.example" listing={listing} tab="overview" />);
    expect(screen.getByText("plugin: { publisher: acme, name: trivy, filter: { version: '^2' } }")).toBeInTheDocument();
  });
});

describe('/sitemap.xml', () => {
  it('lists directory, categories and every plugin from one sitemap call', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      entries: [
        { publisher: 'pipeline-builder', name: 'trivy', updatedAt: '2026-09-21T00:00:00.000Z' },
        { publisher: 'acme', name: 'snyk', updatedAt: '2026-09-20T00:00:00.000Z' },
      ],
    }));
    const { c, res } = ctx();
    await sitemapGssp(c);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.body).toContain('<loc>https://localhost:8443/plugins</loc>');
    expect(res.body).toContain('<loc>https://localhost:8443/plugins/category/security</loc>');
    expect(res.body).toContain('<loc>https://localhost:8443/plugins/pipeline-builder/trivy</loc><lastmod>2026-09-21</lastmod>');
    expect(res.body).toContain('<loc>https://localhost:8443/plugins/acme/snyk</loc>');
    expect(calls()).toHaveLength(1);
    expect(calls()[0].url).toContain('/api/public/plugins/sitemap');
    expectNoCredentials();
  });

  it('answers 503 (not cached) when the API fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500));
    const { c, res } = ctx();
    await sitemapGssp(c);
    expect(res.statusCode).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('404s when the directory is off', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404));
    expect(await sitemapGssp(ctx().c)).toEqual({ notFound: true });
  });
});

describe('/plugins/[publisher]/[name] — Reviews tab SSR', () => {
  it('server-renders the first page of reviews (default sort), credential-free', async () => {
    fetchMock.mockImplementation(async (url: unknown) => (String(url).includes('/reviews')
      ? jsonResponse(200, { reviews: [], total: 0, nextCursor: null })
      : jsonResponse(200, { listing: detail() })));
    const { c } = ctx({ params: { publisher: 'pipeline-builder', name: 'trivy' }, query: { tab: 'reviews' } });
    expect(await pluginGssp(c)).toMatchObject({ props: { tab: 'reviews', initialReviews: { total: 0 } } });
    expect(calls().map((x) => x.url)).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/api\/public\/plugins\/pipeline-builder\/trivy\/reviews\?sort=helpful&limit=10$/),
    ]));
    expectNoCredentials();
  });

  it('does not fetch reviews for another tab', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { listing: detail() }));
    await pluginGssp(ctx({ params: { publisher: 'pipeline-builder', name: 'trivy' }, query: { tab: 'overview' } }).c);
    expect(calls().some((x) => x.url.includes('/reviews'))).toBe(false);
  });
});

describe('/plugins/[publisher]/[name] — Supply chain', () => {
  it('offers each published version\'s own SBOM download', () => {
    asPath = '/plugins/pipeline-builder/trivy?tab=supply-chain';
    const props = { siteUrl: 'https://pb.example', listing: detail(), tab: 'supply-chain' } as PluginPageProps;
    render(<PluginPage {...props} />);
    const v = detail().versions.find((x) => !x.yanked)!;
    expect(screen.getByRole('link', { name: `Download the SBOM for version ${v.version}` }))
      .toHaveAttribute('href', `/api/public/plugins/pipeline-builder/trivy/versions/${v.version}/sbom`);
  });
});
