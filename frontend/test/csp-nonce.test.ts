/**
 * @jest-environment node
 */
// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The nonce-based Content-Security-Policy (src/lib/csp.ts, proxy.ts).
 *
 * Properties under test: scripts are allowed by a fresh per-request nonce and
 * never by `'unsafe-inline'`; `'unsafe-eval'` appears only in development; the
 * proxy sends the SAME nonce to the browser (CSP header) and to the renderer
 * (`x-nonce` request header), overwriting any client-sent value; and the
 * renderer-side reader refuses anything that is not base64.
 */
import { describe, it, expect } from '@jest/globals';
import { NextRequest } from 'next/server';
import { buildContentSecurityPolicy, generateNonce, requestNonce, NONCE_HEADER } from '../src/lib/csp';
import { proxy, config } from '../proxy';

const directive = (csp: string, name: string) =>
  csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));

describe('buildContentSecurityPolicy', () => {
  it('allows scripts by nonce + strict-dynamic, never unsafe-inline', () => {
    const csp = buildContentSecurityPolicy('abc123==');
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-abc123==' 'strict-dynamic'");
    expect(directive(csp, 'script-src')).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('adds unsafe-eval in development only', () => {
    expect(directive(buildContentSecurityPolicy('n', { dev: true }), 'script-src')).toContain("'unsafe-eval'");
  });

  it('keeps the other directives of the static policy it replaced', () => {
    const csp = buildContentSecurityPolicy('n');
    for (const d of [
      "default-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
      "font-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'",
      "form-action 'self'", "object-src 'none'", "worker-src 'self'",
    ]) expect(csp).toContain(d);
  });
});

describe('generateNonce', () => {
  it('is 128 bits of base64, different every time', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(a).not.toBe(b);
  });
});

describe('requestNonce', () => {
  it('reads the proxy header', () => {
    expect(requestNonce({ headers: { [NONCE_HEADER]: 'abc+/=' } })).toBe('abc+/=');
    expect(requestNonce({ headers: { [NONCE_HEADER]: ['first', 'second'] } })).toBe('first');
  });

  it('is undefined outside a request or for a non-base64 value', () => {
    expect(requestNonce(undefined)).toBeUndefined();
    expect(requestNonce({ headers: {} })).toBeUndefined();
    expect(requestNonce({ headers: { [NONCE_HEADER]: '"><script>' } })).toBeUndefined();
  });
});

describe('proxy', () => {
  it('sends one fresh nonce to both the browser and the renderer, overwriting a client value', () => {
    const res = proxy(new NextRequest('https://app.example/dashboard', { headers: { [NONCE_HEADER]: 'forged' } }));
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(nonce).not.toBe('forged');
    // NextResponse.next({ request: { headers } }) forwards overridden request
    // headers to the renderer as `x-middleware-request-<name>`.
    expect(res.headers.get(`x-middleware-request-${NONCE_HEADER}`)).toBe(nonce);

    const again = proxy(new NextRequest('https://app.example/dashboard'));
    expect(again.headers.get('content-security-policy')).not.toBe(csp);
  });

  it('skips static assets, API routes and link prefetches', () => {
    const [{ source, missing }] = config.matcher;
    const re = new RegExp(`^${source}$`);
    expect(re.test('/dashboard')).toBe(true);
    expect(re.test('/')).toBe(true);
    expect(re.test('/_next/static/chunks/a.js')).toBe(false);
    expect(re.test('/api/client-errors')).toBe(false);
    expect(re.test('/plugin-icons/x.svg')).toBe(false);
    expect(missing.map((m) => m.key)).toEqual(['next-router-prefetch', 'purpose']);
  });
});
