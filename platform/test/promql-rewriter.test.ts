// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PromQL rewriter tests. Covers: identifier-vs-function disambiguation,
 * reserved-word handling, string-literal pass-through, brace counting,
 * label-set injection / detection, cross-tenant rejection.
 */

import { injectOrgId, PromQLRewriteError, validateOrgIdMatchers } from '../src/services/promql-rewriter.js';

describe('injectOrgId  basic shapes', () => {
  it('wraps a bare metric name in {org_id="..."}', () => {
    expect(injectOrgId('up', 'acme')).toBe('up{org_id="acme"}');
  });

  it('injects into an existing labelset as the first label', () => {
    expect(injectOrgId('http_requests_total{status="500"}', 'acme'))
      .toBe('http_requests_total{org_id="acme",status="500"}');
  });

  it('injects into an empty labelset', () => {
    expect(injectOrgId('http_requests_total{}', 'acme'))
      .toBe('http_requests_total{org_id="acme"}');
  });

  it('leaves the expression unchanged when org_id is already present', () => {
    const expr = 'http_requests_total{org_id="acme",status="500"}';
    expect(injectOrgId(expr, 'acme')).toBe(expr);
  });

  it('leaves the expression unchanged with the regex form (=~)', () => {
    const expr = 'http_requests_total{org_id=~"acme",status="500"}';
    expect(injectOrgId(expr, 'acme')).toBe(expr);
  });

  it('is idempotent  running twice produces the same output', () => {
    const once = injectOrgId('rate(http_requests_total[5m])', 'acme');
    expect(injectOrgId(once, 'acme')).toBe(once);
  });
});

describe('injectOrgId  function-vs-metric disambiguation', () => {
  it('does not wrap function names like rate/sum/avg', () => {
    expect(injectOrgId('rate(up[5m])', 'acme'))
      .toBe('rate(up{org_id="acme"}[5m])');
  });

  it('handles nested aggregations', () => {
    expect(injectOrgId('sum(rate(http_requests_total[5m]))', 'acme'))
      .toBe('sum(rate(http_requests_total{org_id="acme"}[5m]))');
  });

  it('handles aggregation modifiers (by, without)', () => {
    expect(injectOrgId('sum by (status) (rate(http_requests_total[5m]))', 'acme'))
      .toBe('sum by (status) (rate(http_requests_total{org_id="acme"}[5m]))');
  });

  it('handles "and / or / unless" operator keywords', () => {
    const out = injectOrgId('up and on(instance) node_load1', 'acme');
    expect(out).toBe('up{org_id="acme"} and on(instance) node_load1{org_id="acme"}');
  });

  it('does not inject into histogram_quantile (function)', () => {
    expect(injectOrgId('histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))', 'acme'))
      .toBe('histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{org_id="acme"}[5m])))');
  });
});

describe('injectOrgId  multiple metrics in one expression', () => {
  it('injects into every metric in a binary expression', () => {
    const out = injectOrgId('rate(http_requests_total[5m]) / rate(http_requests_failures[5m])', 'acme');
    expect(out).toBe( 'rate(http_requests_total{org_id="acme"}[5m]) / rate(http_requests_failures{org_id="acme"}[5m])',
    );
  });

  it('preserves labelsets on each metric independently', () => {
    const out = injectOrgId( 'rate(http_requests_total{status="5xx"}[5m]) / rate(http_requests_total[5m])',
      'acme',
    );
    expect(out).toBe( 'rate(http_requests_total{org_id="acme",status="5xx"}[5m]) / rate(http_requests_total{org_id="acme"}[5m])',
    );
  });
});

describe('injectOrgId  string literals + escapes', () => {
  it('does not treat identifier-looking text inside a string as a metric', () => {
    const out = injectOrgId('label_replace(up, "dst", "$1", "instance", "(.*):.*")', 'acme');
    expect(out).toBe('label_replace(up{org_id="acme"}, "dst", "$1", "instance", "(.*):.*")');
  });

  it('handles escaped quotes inside string literals', () => {
    const out = injectOrgId('label_replace(up, "dst", "v\\"x", "instance", "")', 'acme');
    expect(out).toBe('label_replace(up{org_id="acme"}, "dst", "v\\"x", "instance", "")');
  });
});

describe('injectOrgId  security gates', () => {
  it('rejects an expression with a comment (#)', () => {
    expect(() => injectOrgId('up # org_id="acme"', 'acme')).toThrow(/Comments/);
  });

  it('rejects when a metric references a DIFFERENT org_id', () => {
    expect(() => injectOrgId('http_requests_total{org_id="other"}', 'acme'))
      .toThrow(/doesn't match the rule's own org/);
  });

  it('rejects unbalanced braces', () => {
    expect(() => injectOrgId('http_requests_total{status="500"', 'acme'))
      .toThrow(/Unbalanced/);
  });

  it('rejects unterminated string literal', () => {
    expect(() => injectOrgId('label_replace(up, "dst, "x", "instance", "")', 'acme'))
      .toThrow(PromQLRewriteError);
  });
});

describe('validateOrgIdMatchers  validation-only mode', () => {
  it('returns ok when every metric has the matcher', () => {
    const r = validateOrgIdMatchers('rate(http_requests_total{org_id="acme"}[5m]) > 5', 'acme');
    expect(r).toEqual({ ok: true });
  });

  it('fails when a bare metric lacks the matcher', () => {
    const r = validateOrgIdMatchers('rate(http_requests_total[5m]) > 5', 'acme');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('http_requests_total');
  });

  it('fails when ONE of several metrics lacks the matcher', () => {
    const r = validateOrgIdMatchers( 'rate(http_requests_total{org_id="acme"}[5m]) / rate(failures[5m])',
      'acme',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('failures');
  });

  it('fails fast on a cross-tenant attempt', () => {
    const r = validateOrgIdMatchers('http_requests_total{org_id="other"}', 'acme');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("doesn't match");
  });
});
