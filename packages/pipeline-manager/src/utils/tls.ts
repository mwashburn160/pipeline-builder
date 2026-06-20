// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import https from 'https';

/**
 * Hosts that legitimately front a self-signed certificate — local dev stacks and
 * kubectl port-forwards. Everything else (a real deploy domain) is expected to
 * present a valid (ACM) certificate and MUST be verified, so a post-deploy probe
 * can't be silently MITM'd.
 */
export function isLocalHttpsHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

/**
 * Return an https.Agent that skips certificate verification ONLY for local /
 * self-signed hosts; returns `undefined` (Node's default verification) for real
 * domains. Pass the result straight to axios' `httpsAgent` — `undefined` keeps the
 * default secure behavior.
 */
export function httpsAgentForUrl(url: string): https.Agent | undefined {
  return isLocalHttpsHost(url) ? new https.Agent({ rejectUnauthorized: false }) : undefined;
}
