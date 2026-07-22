// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime absolute base URL for social-card (Open Graph / Twitter) assets.
 *
 * Read SERVER-SIDE at request time from `APP_SITE_URL` — a plain runtime env,
 * NOT `NEXT_PUBLIC_*` (which is inlined at `next build`). The frontend ships as a
 * single shared image across environments (local docker, minikube, EC2, EKS), so
 * the public origin can't be baked at build time; each deployment instead sets
 * `APP_SITE_URL` to its own public origin. OG requires an ABSOLUTE image URL, and
 * the tags must be server-rendered to be seen by scrapers, so pages expose the
 * value via {@link siteUrlServerSideProps}.
 *
 * Trailing slashes are stripped so a `${siteUrl}/og-image.png` concat can never
 * produce a double slash.
 */
export const DEFAULT_SITE_URL = 'https://localhost:8443';

/** Resolve the public origin from the runtime env, with a local-docker default. */
export function resolveSiteUrl(): string {
  return (process.env.APP_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');
}

/** Prop injected into pages that render social cards. */
export interface WithSiteUrl {
  siteUrl: string;
}

/**
 * Reusable `getServerSideProps` that injects the resolved site URL as a prop.
 * Forcing SSR (over static optimization) is deliberate: it's what lets the OG
 * tags carry the per-deployment absolute URL AND land in the server-rendered
 * HTML that social scrapers read.
 */
export async function siteUrlServerSideProps(): Promise<{ props: WithSiteUrl }> {
  return { props: { siteUrl: resolveSiteUrl() } };
}
