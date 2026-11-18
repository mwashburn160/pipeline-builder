// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PromQL rewriter tests. Covers: identifier-vs-function disambiguation,
 * reserved-word handling, string-literal pass-through, brace counting,
 * label-set injection / detection, cross-tenant rejection.
 */

import { describe, it, expect } from '@jest/globals';
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

  it('still injects the equality matcher alongside a regex org_id (=~) — regexes never count as pinned', () => {
    expect(injectOrgId('http_requests_total{org_id=~"acme",status="500"}', 'acme'))
      .toBe('http_requests_total{org_id="acme",org_id=~"acme",status="500"}');
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

describe('injectOrgId  nameless label-set selectors (tenancy-gate bypass)', () => {
  it('org-scopes a bare `{job=...}` label-set selector (no metric name)', () => {
    expect(injectOrgId('{job="platform"} > 0', 'acme'))
      .toBe('{org_id="acme",job="platform"} > 0');
  });

  it('org-scopes a `{__name__=~...}` selector', () => {
    expect(injectOrgId('{__name__=~"plugin_builds_total"}', 'acme'))
      .toBe('{org_id="acme",__name__=~"plugin_builds_total"}');
  });

  // Regression guard for the HIGH bug: a bare label-set whose FIRST label name
  // is a PromQL reserved word (`on`, `by`, `sum`, `count`, `ignoring`, …) used
  // to be recorded as NOTHING, so the selector escaped the org_id gate entirely
  // (injected nothing + validated ok over an empty list). It must now be scoped.
  it.each(['on', 'by', 'sum', 'count', 'ignoring', 'rate'])(
    'org-scopes a bare label-set led by reserved word %p', (label) => {
      expect(injectOrgId(`{${label}="x"} > 0`, 'acme'))
        .toBe(`{org_id="acme",${label}="x"} > 0`);
    },
  );

  it('leaves a nameless selector that already carries org_id unchanged', () => {
    expect(injectOrgId('{org_id="acme",job="x"}', 'acme')).toBe('{org_id="acme",job="x"}');
  });

  it('rejects a nameless selector pinned to a DIFFERENT org', () => {
    expect(() => injectOrgId('{org_id="other"}', 'acme'))
      .toThrow(/doesn't match the rule's own org/);
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

  it('rejects a nameless label-set selector missing the matcher', () => {
    const r = validateOrgIdMatchers('{on="platform"} > 0', 'acme');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('label-set selector');
  });

  it('accepts a nameless label-set selector that carries org_id', () => {
    expect(validateOrgIdMatchers('{org_id="acme",job="x"}', 'acme')).toEqual({ ok: true });
  });
});

describe('injectOrgId  tokenizer-level tenancy bypasses (survey 2026-09-21)', () => {
  // The old regex matcher saw `org_id='X'` INSIDE the regex value and treated
  // the selector as already pinned — the injected expression then matched
  // every org via `|.+`.
  it('injects into a selector whose regex VALUE merely contains org_id=\'X\'', () => {
    expect(injectOrgId('up{job=~"org_id=\'acme\'|.+"}', 'acme'))
      .toBe('up{org_id="acme",job=~"org_id=\'acme\'|.+"}');
  });

  it('does not accept a label whose name merely ENDS in org_id (xorg_id)', () => {
    expect(injectOrgId('up{xorg_id="acme"}', 'acme')).toBe('up{org_id="acme",xorg_id="acme"}');
    expect(validateOrgIdMatchers('up{xorg_id="acme"}', 'acme').ok).toBe(false);
  });

  it('does not treat a foreign xorg_id value as a cross-tenant pin either (just ANDs)', () => {
    expect(injectOrgId('up{xorg_id="other"}', 'acme')).toBe('up{org_id="acme",xorg_id="other"}');
  });

  it('tokenizes backtick raw strings (a `"` inside cannot desync the scanner)', () => {
    // Old scanner: the `"` inside the backticks opened a string, hiding the
    // following `other_metric` selector from injection entirely.
    expect(injectOrgId('up{job=`a"`} + other_metric{job=`"`}', 'acme'))
      .toBe('up{org_id="acme",job=`a"`} + other_metric{org_id="acme",job=`"`}');
  });

  it('recognizes an exact org_id pin written as a backtick raw string', () => {
    expect(injectOrgId('up{org_id=`acme`}', 'acme')).toBe('up{org_id=`acme`}');
  });

  it('injects when the org_id value uses escapes (never assumed equal)', () => {
    expect(injectOrgId('up{org_id="ac\\x6de"}', 'acme')).toBe('up{org_id="acme",org_id="ac\\x6de"}');
  });

  it('ANDs with negative / wildcard org_id matchers instead of trusting them', () => {
    expect(injectOrgId('up{org_id!="nobody"}', 'acme')).toBe('up{org_id="acme",org_id!="nobody"}');
    expect(injectOrgId('up{org_id=~".+"}', 'acme')).toBe('up{org_id="acme",org_id=~".+"}');
  });

  it('treats a function name used WITHOUT a call as a metric (sum(rate) selects metric "rate")', () => {
    expect(injectOrgId('sum(rate)', 'acme')).toBe('sum(rate{org_id="acme"})');
    expect(injectOrgId('vector + up', 'acme')).toBe('vector{org_id="acme"} + up{org_id="acme"}');
  });

  it('handles a quoted (UTF-8) metric-name element inside braces', () => {
    expect(injectOrgId('{"my.metric", job="x"}', 'acme')).toBe('{org_id="acme","my.metric", job="x"}');
  });

  it('leaves subquery/duration brackets alone', () => {
    expect(injectOrgId('max_over_time(rate(up[5m])[1h:1m])', 'acme'))
      .toBe('max_over_time(rate(up{org_id="acme"}[5m])[1h:1m])');
  });

  it('handles offset and @ modifiers', () => {
    expect(injectOrgId('up offset 5m', 'acme')).toBe('up{org_id="acme"} offset 5m');
    expect(injectOrgId('up @ end()', 'acme')).toBe('up{org_id="acme"} @ end()');
  });

  it('rejects unlexable characters and malformed matchers', () => {
    expect(() => injectOrgId('up | down', 'acme')).toThrow(PromQLRewriteError);
    expect(() => injectOrgId('up{job}', 'acme')).toThrow(/Malformed label matcher/);
    expect(() => injectOrgId('up{job=foo}', 'acme')).toThrow(/string literal/);
    expect(() => injectOrgId('up{job="a"}}', 'acme')).toThrow(/Unbalanced/);
    expect(() => injectOrgId('up{job=`unterminated}', 'acme')).toThrow(/Unterminated/);
  });

  it('allows # inside a string literal but not as a comment', () => {
    expect(injectOrgId('up{job="a#b"}', 'acme')).toBe('up{org_id="acme",job="a#b"}');
  });

  it('is idempotent over every exploit shape', () => {
    for (const e of ['up{job=~"org_id=\'acme\'|.+"}', 'up{xorg_id="acme"}', 'up{job=`a"`}', '{on="x"}', 'sum(rate)']) {
      const once = injectOrgId(e, 'acme');
      expect(injectOrgId(once, 'acme')).toBe(once);
      expect(validateOrgIdMatchers(once, 'acme')).toEqual({ ok: true });
    }
  });

  it('validation mode rejects the exploit strings un-rewritten', () => {
    expect(validateOrgIdMatchers('up{job=~"org_id=\'acme\'|.+"}', 'acme').ok).toBe(false);
    expect(validateOrgIdMatchers('up{org_id=~"acme"}', 'acme').ok).toBe(false);
    expect(validateOrgIdMatchers('up{job=`org_id="acme"`}', 'acme').ok).toBe(false);
  });
});
