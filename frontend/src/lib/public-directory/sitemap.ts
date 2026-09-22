// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Sitemap XML for the public plugin directory (pages/sitemap.xml.ts). */

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string));
}

export interface SitemapEntry { loc: string; lastmod?: string }

export function renderSitemap(entries: SitemapEntry[]): string {
  const urls = entries.map((e) => {
    const lastmod = e.lastmod ? `<lastmod>${escapeXml(e.lastmod.slice(0, 10))}</lastmod>` : '';
    return `  <url><loc>${escapeXml(e.loc)}</loc>${lastmod}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
