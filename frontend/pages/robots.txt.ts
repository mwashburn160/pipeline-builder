// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/robots.txt` — see `renderRobots`. Rendered per request so the `Sitemap:`
 * line carries this deployment's absolute origin (`APP_SITE_URL`).
 */
import type { GetServerSideProps } from 'next';
import { resolveSiteUrl } from '@/lib/site-url';
import { PUBLIC_CACHE_CONTROL } from '@/lib/public-directory/server';
import { renderRobots } from '@/lib/public-directory/robots';

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
  res.write(renderRobots(resolveSiteUrl()));
  res.end();
  return { props: {} };
};

/** Never rendered: the response is written in `getServerSideProps`. */
export default function Robots() {
  return null;
}
