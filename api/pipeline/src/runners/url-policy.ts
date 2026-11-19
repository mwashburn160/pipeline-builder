// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a runner may be reached: an AWS Lambda Function URL or an API
 * Gateway execute-api endpoint, over https, with no userinfo and no explicit
 * port. A host allowlist rather than a denylist — together with `safeFetch`'s
 * pinned, private-range-refusing connect it leaves no way to aim the platform's
 * signed POSTs at an internal address (SSRF).
 */

const LAMBDA_URL_HOST = /^[a-z0-9]+\.lambda-url\.[a-z0-9-]+\.on\.aws$/;
// `amazonaws.com.cn` is the China partition's URL suffix (the runner template uses ${AWS::URLSuffix}).
const EXECUTE_API_HOST = /^[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export type FunctionUrlCheck = { ok: true; url: string } | { ok: false; error: string };

/** Validate (and normalize) a runner's URL. Error text never echoes the URL. */
export function checkFunctionUrl(raw: unknown): FunctionUrlCheck {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return { ok: false, error: 'functionUrl is required' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'functionUrl is not a valid URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'functionUrl must use https' };
  if (url.username || url.password) return { ok: false, error: 'functionUrl must not carry credentials' };
  if (url.port) return { ok: false, error: 'functionUrl must not name a port' };
  const host = url.hostname.toLowerCase();
  if (!LAMBDA_URL_HOST.test(host) && !EXECUTE_API_HOST.test(host)) {
    return { ok: false, error: 'functionUrl must be a Lambda Function URL (*.lambda-url.<region>.on.aws) or an API Gateway endpoint (*.execute-api.<region>.amazonaws.com[.cn])' };
  }
  if (url.hash) return { ok: false, error: 'functionUrl must not carry a fragment' };
  return { ok: true, url: url.toString() };
}
