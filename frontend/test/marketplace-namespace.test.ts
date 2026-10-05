// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/marketplace/register` owns the `/marketplace` namespace alone.
 *
 * It is the AWS Marketplace fulfillment URL: AWS POSTs an
 * `application/x-www-form-urlencoded` body carrying `x-amzn-marketplace-token`
 * (a FIELD, despite the `x-` in the name) once, after a customer subscribes.
 * The token is single-use and short-lived.
 *
 * `/marketplace` used to be an alias serving the plugin directory under its own
 * name, which put two unrelated meanings of "marketplace" one path segment
 * apart and kept them separated only by a rewrite `source` being exact. A
 * wildcard, a reorder, or a proxy-level block would have swallowed the landing
 * page and answered a buyer's POST with a plugin list: HTTP 200, no error
 * anywhere, token gone. The alias is gone; the directory is at `/plugins`.
 *
 * So what this pins is an ABSENCE, which is the kind of thing that rots
 * silently: nothing may claim `/marketplace` again — not a rewrite, not a
 * redirect, not an index page, not an nginx `location` on any deploy target —
 * while `/marketplace/register` keeps reaching its own route.
 */

import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface Rewrite {
  source: string;
  destination: string;
  has?: { type: string; key: string; value?: string }[];
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nextConfig = require('../next.config.js') as {
  rewrites: () => Promise<Rewrite[]>;
  redirects?: () => Promise<unknown[]>;
};

const PAGES = join(__dirname, '..', 'pages');

describe('the /marketplace namespace', () => {
  it('is claimed by no rewrite', async () => {
    const rewrites = await nextConfig.rewrites();
    // Both directions: nothing may route /marketplace anywhere, and nothing may
    // route anywhere INTO the namespace either — a rewrite whose destination is
    // /marketplace/register would mean some other path can reach the landing
    // page, which is the AWS contract and should have exactly one entry point.
    for (const r of rewrites) {
      expect([r.source, r.destination]).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^\/marketplace(\/|$)/)]),
      );
    }
  });

  it('is claimed by no redirect', async () => {
    const redirects = nextConfig.redirects ? await nextConfig.redirects() : [];
    expect(JSON.stringify(redirects)).not.toContain('/marketplace');
  });

  it('has exactly one page in it — the entitlement landing', () => {
    expect(existsSync(join(PAGES, 'marketplace', 'register.tsx'))).toBe(true);
    // An index page would make /marketplace answer 200 again, so a fulfillment
    // URL mis-set to the bare path would render something instead of 404ing.
    // A 404 reaches the buyer right after purchase and gets reported; a 200 does
    // not, and the token expires in the quiet.
    for (const ext of ['tsx', 'ts', 'jsx', 'js']) {
      expect([ext, existsSync(join(PAGES, 'marketplace', `index.${ext}`))]).toEqual([ext, false]);
    }
  });

  it('is not claimed by nginx on any deploy target', () => {
    // nginx sees the request first. A `location` on /marketplace — prefix or
    // exact — can pre-empt Next entirely, and a prefix one would also capture
    // /marketplace/register.
    const root = join(__dirname, '..', '..', 'deploy');
    for (const target of ['aws/ec2', 'aws/eks', 'local/docker', 'local/minikube']) {
      const conf = join(root, target, 'nginx', 'nginx.conf');
      expect([target, existsSync(conf)]).toEqual([target, true]);
      // Anchored at the path, not a substring: `/api/billing/marketplace/resolve`
      // is a different namespace that merely contains the word, and IS a
      // location block (it returns 404 so the registration exchange stays
      // server-to-server). Matching on `includes` would fail on that.
      const directives = readFileSync(conf, 'utf-8')
        .split('\n')
        .map((l) => l.replace(/#.*$/, '').trim())
        .filter((l) => /^location\s+(?:=\s*|\^~\s*|~\*?\s*)?\/marketplace(?:[/\s{]|$)/.test(l));
      expect([target, directives]).toEqual([target, []]);
    }
  });
});
