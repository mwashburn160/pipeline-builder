// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** URLs and small derivations shared by the public directory pages. */
import { OFFICIAL_PUBLISHER } from './types';

/** The project's source repository (docs links on category pages). */
export const PROJECT_REPO_URL = 'https://github.com/mwashburn160/pipeline-builder';

/** The per-category plugin doc on GitHub (`docs/plugins/<category>.md`). */
export function categoryDocUrl(category: string): string {
  return `${PROJECT_REPO_URL}/blob/main/docs/plugins/${encodeURIComponent(category)}.md`;
}

/** `/plugins/<publisher>/<name>` — the listing's public page. */
export function pluginPagePath(publisher: string, name: string): string {
  return `/plugins/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}`;
}

/** `/plugins/category/<id>`. */
export function categoryPagePath(category: string): string {
  return `/plugins/category/${encodeURIComponent(category)}`;
}

/**
 * The stable sign-in link carrying where to come back to. `/login` sanitizes
 * `returnTo` itself; this only encodes it.
 */
export function loginHref(returnTo?: string | null): string {
  return returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login';
}

/** Major version for a `^<major>` range, or null when the version isn't semver-shaped. */
export function majorOf(version: string): string | null {
  const m = /^v?(\d+)\.\d+/.exec(version.trim());
  return m ? String(Number(m[1])) : null;
}

/**
 * The pipeline reference for a listing, as it's written in a pipeline config.
 * The `pipeline-builder` publisher is implicit, so Official plugins omit it.
 */
export function pipelineSnippet(publisher: string, name: string, latestVersion: string): string {
  const parts: string[] = [];
  if (publisher !== OFFICIAL_PUBLISHER) parts.push(`publisher: ${publisher}`);
  parts.push(`name: ${name}`);
  const major = majorOf(latestVersion);
  if (major !== null) parts.push(`filter: { version: '^${major}' }`);
  return `plugin: { ${parts.join(', ')} }`;
}

/** Only same-origin paths or https URLs are ever rendered as links from listing data. */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}
