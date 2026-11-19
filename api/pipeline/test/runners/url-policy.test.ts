// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from '@jest/globals';
import { checkFunctionUrl } from '../../src/runners/url-policy.js';

describe('checkFunctionUrl (host allowlist — the SSRF boundary for runner URLs)', () => {
  it.each([
    'https://abc123.lambda-url.us-east-1.on.aws/',
    'https://abc123.lambda-url.eu-west-2.on.aws',
    'https://a1b2c3.execute-api.us-west-2.amazonaws.com/prod/run',
    'https://a1b2c3.execute-api.cn-north-1.amazonaws.com.cn/prod',
  ])('accepts %s', (url) => {
    expect(checkFunctionUrl(url)).toEqual({ ok: true, url: expect.stringMatching(/^https:\/\//) });
  });

  it.each([
    ['http://abc.lambda-url.us-east-1.on.aws/', 'https'],
    ['https://user:pw@abc.lambda-url.us-east-1.on.aws/', 'credentials'],
    ['https://abc.lambda-url.us-east-1.on.aws:8443/', 'port'],
    ['https://169.254.169.254/latest/meta-data', 'Lambda Function URL'],
    ['https://127.0.0.1/', 'Lambda Function URL'],
    ['https://localhost/', 'Lambda Function URL'],
    ['https://pipeline.pipeline-builder.svc.cluster.local/', 'Lambda Function URL'],
    ['https://abc.lambda-url.us-east-1.on.aws.evil.com/', 'Lambda Function URL'],
    ['https://evil.com/abc.lambda-url.us-east-1.on.aws', 'Lambda Function URL'],
    ['https://a.b.lambda-url.us-east-1.on.aws/', 'Lambda Function URL'],
    ['https://abc.lambda-url.us-east-1.on.aws/#frag', 'fragment'],
    ['not a url', 'valid URL'],
    ['', 'required'],
  ])('rejects %s', (url, why) => {
    const r = checkFunctionUrl(url);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(why);
      // The refusal never echoes the URL back.
      expect(r.error).not.toContain(url || '\u0000');
    }
  });

  it('rejects a non-string', () => {
    expect(checkFunctionUrl(42).ok).toBe(false);
    expect(checkFunctionUrl('x'.repeat(3000)).ok).toBe(false);
  });
});
