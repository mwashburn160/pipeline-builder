// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * nginx's default Cache-Control must not be stacked on an upstream's own.
 *
 * The gateway adds `private, max-age=10…` (GET) / `no-store` to every response.
 * The public plugin directory answers with its own `public, max-age=300…`, and
 * nginx sent BOTH headers: clients and caches then pick either, so the
 * directory's caching policy was undefined. The default applies only when the
 * upstream set none.
 */

import { describe, expect, it } from '@jest/globals';
import { ALL_TARGETS, read } from '../src/index.js';

describe.each(ALL_TARGETS.map((t) => [t]))('%s nginx.conf', (target) => {
  const conf = read(`${target}/nginx/nginx.conf`);

  it('keys the default Cache-Control on the upstream having none', () => {
    const map = conf.match(/map \$upstream_http_cache_control \$cache_control_header \{([^}]*)\}/);
    expect(map).not.toBeNull();
    // No upstream header → the method default; any upstream header → empty (nginx skips an empty add_header).
    expect(map![1]).toMatch(/""\s+\$cache_control_by_method;/);
    expect(map![1]).toMatch(/default\s+"";/);
  });

  it('keeps the per-method default policy', () => {
    const byMethod = conf.match(/map \$request_method \$cache_control_by_method \{([^}]*)\}/);
    expect(byMethod).not.toBeNull();
    expect(byMethod![1]).toContain('"private, max-age=10, stale-while-revalidate=30"');
    expect(byMethod![1]).toMatch(/default\s+"no-store";/);
  });

  it('adds the header from the upstream-aware map', () => {
    expect(conf).toContain('add_header Cache-Control $cache_control_header always;');
  });

  // The only Cache-Control nginx adds is the upstream-aware server default. A
  // location-level one (the old `/_next/` immutable header) stacks a second,
  // conflicting header on the upstream's own (Next's `/_next/image` answers
  // `max-age=60, must-revalidate` and got a year of `immutable` on top), and any
  // location `add_header` silently drops every server-level header (HSTS,
  // nosniff, X-Request-ID, the CSP fallback) for that location.
  it('adds no Cache-Control of its own in any location', () => {
    const literal = conf.match(/add_header\s+Cache-Control\s+(?!\$cache_control_header\b)[^;]*;/g) ?? [];
    expect(literal).toEqual([]);
  });

  it('proxies /_next/ with the server-level headers (no location add_header)', () => {
    const block = conf.match(/location \/_next\/ \{([^}]*)\}/);
    expect(block).not.toBeNull();
    expect(block![1]).not.toMatch(/\badd_header\b/);
  });

  // proxy_cache_valid only applies with a proxy_cache zone; none is defined, so
  // the directive reads as a gateway cache that does not exist.
  it('declares no proxy_cache_valid without a proxy_cache zone', () => {
    if (!/proxy_cache_path\b/.test(conf)) expect(conf).not.toMatch(/proxy_cache_valid\b/);
  });
});
