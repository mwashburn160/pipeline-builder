// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/marketplace` serves the plugin directory with the address bar unchanged.
 *
 * It is a Next rewrite rather than an nginx one because the directory is a Next
 * route: its hydration payload, `_next/data` fetches and internal links all name
 * `/plugins`, so a proxy-level rewrite serves the right HTML and the client
 * router then corrects the URL straight back. Next owning the mapping is what
 * keeps the request and response sides agreeing.
 *
 * The risks worth pinning are that the rewrite disappears, that it turns into a
 * redirect, and that it grows to swallow `/marketplace/register` — a real page
 * (the AWS Marketplace entitlement landing) that must keep reaching its own route.
 */

import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nextConfig = require('../next.config.js') as {
  rewrites: () => Promise<{ source: string; destination: string }[]>;
  redirects?: () => Promise<unknown[]>;
};

describe('/marketplace alias', () => {
  it('rewrites the bare path to the plugin directory', async () => {
    const rewrites = await nextConfig.rewrites();
    expect(rewrites).toContainEqual({ source: '/marketplace', destination: '/plugins' });
  });

  it('matches the bare path ONLY, so /marketplace/register keeps its own route', async () => {
    const rewrites = await nextConfig.rewrites();
    const sources = rewrites.map((r) => r.source);
    // An exact `source` never matches sub-paths. A wildcard here (`/marketplace/:path*`)
    // would capture the entitlement landing and send buyers to the directory.
    expect(sources).toContain('/marketplace');
    expect(sources.some((s) => s.startsWith('/marketplace/') || s.startsWith('/marketplace:'))).toBe(false);

    expect(existsSync(join(__dirname, '..', 'pages', 'marketplace', 'register.tsx'))).toBe(true);
  });

  it('is a rewrite, not a redirect — the address bar must not change', async () => {
    const redirects = nextConfig.redirects ? await nextConfig.redirects() : [];
    expect(JSON.stringify(redirects)).not.toContain('/marketplace');
  });

  it('is not pre-empted by an nginx redirect on any deploy target', () => {
    // nginx sees the request first; a `location = /marketplace` there would 301
    // before Next ever gets it, undoing the whole point of the rewrite.
    const root = join(__dirname, '..', '..', 'deploy');
    for (const target of ['aws/ec2', 'aws/eks', 'local/docker', 'local/minikube']) {
      const conf = join(root, target, 'nginx', 'nginx.conf');
      expect([target, existsSync(conf)]).toEqual([target, true]);
      expect([target, readFileSync(conf, 'utf-8')]).not.toEqual([target, expect.stringContaining('location = /marketplace')]);
    }
  });
});
