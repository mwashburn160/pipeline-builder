// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Masking corpus for the Logs surface.
 *
 * These lines are the shape of what actually reaches Loki after promtail's
 * `output: { source: msg }` rewrite — free text, not structured metadata — so
 * key-based redaction never sees them. Every case here must be masked before a
 * tenant can read or export it.
 */

import { describe, it, expect } from '@jest/globals';

import {
  SENSITIVE_VALUE_PATTERNS,
  looksSensitive,
  maskLine,
} from '../src/utils/sensitive-patterns.js';

const REDACTED = '[REDACTED]';

describe('maskLine', () => {
  it.each([
    ['JWT', 'auth ok for eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc-DEF_123'],
    ['bearer header', 'upstream call with Authorization: Bearer sk-abc123DEF456ghi'],
    ['AWS access key id', 'assumed role using AKIAIOSFODNN7EXAMPLE'],
    ['Stripe live key', 'charge failed for sk_live_51H8xQ2abcdefGHIJ'],
    ['GitHub token', 'clone failed: ghp_16CharactersAndThenSomeMore123'],
    ['GitHub fine-grained PAT', 'clone failed: github_pat_11ABCDEFG0abcdefghijkl_AbCdEf0123456789ghIJklMNop'],
    ['GitLab PAT', 'clone failed: glpat-abcdefghij0123456789'],
    ['Slack token', 'notify failed xoxb-123456789012-abcdefghij'],
    ['postgres URL credentials', 'connect postgres://appuser:hunter2@db:5432/pb'],
    ['mongodb+srv URL credentials', 'connect mongodb+srv://svc:p%40ss@cluster0.mongodb.net'],
    ['query-string token', 'GET /api/thing?token=abc123XYZ&page=2'],
    ['query-string api_key', 'GET /v1/x?api_key=9f8e7d6c5b4a'],
    ['inline assignment', 'starting worker with client_secret=super-sekrit-value'],
    ['PEM header', 'loaded -----BEGIN RSA PRIVATE KEY----- from disk'],
  ])('masks %s', (_label, line) => {
    const masked = maskLine(line);
    expect(masked).toContain(REDACTED);
    expect(masked).not.toBe(line);
  });

  it('keeps the surrounding line readable rather than nuking it', () => {
    // A masked line still has to be useful for debugging — the parameter name,
    // the scheme and the path all survive; only the secret goes.
    expect(maskLine('GET /api/thing?token=abc123XYZ&page=2'))
      .toBe(`GET /api/thing?token=${REDACTED}&page=2`);
    expect(maskLine('connect postgres://appuser:hunter2@db:5432/pb'))
      .toBe(`connect postgres://${REDACTED}@db:5432/pb`);
  });

  it('scrubs AWS account ids (composed from aws-scrub, a hard repo rule)', () => {
    expect(maskLine('arn:aws:kms:us-east-1:123456789012:key/abc')).not.toContain('123456789012');
  });

  it('leaves ordinary log lines untouched', () => {
    const benign = 'Pipeline run 42 completed in 1830ms for org acme';
    expect(maskLine(benign)).toBe(benign);
  });

  it('is stable across repeated calls (global regexes must not carry lastIndex)', () => {
    const line = 'token=abc123XYZ and token=def456UVW';
    const first = maskLine(line);
    // A stateful /g RegExp shared between calls skips matches on alternate runs;
    // this is the regression guard for that.
    expect(maskLine(line)).toBe(first);
    expect(first).not.toContain('abc123XYZ');
    expect(first).not.toContain('def456UVW');
  });

  it('is idempotent — masking an already-masked line changes nothing', () => {
    const once = maskLine('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig');
    expect(maskLine(once)).toBe(once);
  });

  it('handles empty input', () => {
    expect(maskLine('')).toBe('');
  });
});

describe('looksSensitive', () => {
  it('flags a search term that is itself a secret', () => {
    // Closes the other end of the masking oracle: masking the RESULT is
    // pointless if a user can confirm a guess from whether it matched.
    expect(looksSensitive('sk_live_51H8xQ2abcdefGHIJ')).toBe(true);
    expect(looksSensitive('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.zzz')).toBe(true);
    // Fine-grained GitHub and GitLab PATs: the search-oracle half of the
    // defence, and the half that was missing until the prefixes were added.
    expect(looksSensitive('github_pat_11ABCDEFG0abcdefghijkl_AbCdEf0123456789ghIJklMNop')).toBe(true);
    expect(looksSensitive('glpat-abcdefghij0123456789')).toBe(true);
  });

  it('allows an ordinary search term', () => {
    expect(looksSensitive('connection refused')).toBe(false);
    expect(looksSensitive('pipeline-42')).toBe(false);
  });
});

describe('promtail portability', () => {
  it('every RE2 source compiles and is lookaround-free', () => {
    // Go's RE2 has no lookaround. A pattern needing it must declare `re2: null`
    // and stay Node-side rather than silently failing to load in promtail.
    for (const p of SENSITIVE_VALUE_PATTERNS) {
      if (p.re2 === null) continue;
      expect(p.re2).not.toMatch(/\(\?[=!<]/);
      expect(() => new RegExp(p.re2!.replace(/^\(\?i\)/, ''))).not.toThrow();
    }
  });

  it('exposes at least one ingest-maskable pattern per high-risk credential class', () => {
    const named = new Set(SENSITIVE_VALUE_PATTERNS.filter((p) => p.re2 !== null).map((p) => p.name));
    for (const required of [
      'jwt', 'bearer_token', 'aws_access_key_id', 'url_credentials', 'url_secret_param',
      'github_token', 'github_fine_grained_pat', 'gitlab_token', 'stripe_key', 'slack_token',
    ]) {
      expect(named).toContain(required);
    }
  });
});
