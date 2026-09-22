// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `robots.txt` for the deployment's own origin. Crawlers may read the public
 * directory and the landing page; the signed-in app and the API are not for
 * them (they are auth-walled anyway — this just stops the wasted crawl and the
 * login-redirect noise in search consoles). The sitemap is named with an
 * absolute URL, as the protocol requires, which is why this is rendered per
 * request from `APP_SITE_URL` rather than shipped as a static file.
 */
export function renderRobots(siteUrl: string): string {
  return [
    'User-agent: *',
    'Disallow: /dashboard',
    'Disallow: /api/',
    'Disallow: /auth/',
    'Disallow: /invite/',
    'Disallow: /plugins/submit',
    'Allow: /',
    '',
    `Sitemap: ${siteUrl}/sitemap.xml`,
    '',
  ].join('\n');
}
