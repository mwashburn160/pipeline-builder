// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Request } from 'express';

/** Device details recorded on a refresh-session slot. */
export interface ClientInfo {
  /** Short, human-readable client summary — never the raw header. */
  userAgent?: string;
  /** Client IP as resolved by Express (`trust proxy` aware). */
  ip?: string;
}

/** Ordered: the first match wins, so more specific tokens come first (Edge/Opera
 *  also advertise Chrome; Chrome also advertises Safari). */
const CLIENTS: ReadonlyArray<[RegExp, string]> = [
  [/pipeline-manager/i, 'pipeline-manager CLI'],
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\//, 'Opera'],
  [/\bFirefox\//, 'Firefox'],
  [/\bChrome\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
  [/^curl\//i, 'curl'],
  [/\baxios\//i, 'axios'],
  [/^node(?:-fetch)?\b|\bundici\b/i, 'Node.js'],
  [/^python-requests\//i, 'Python requests'],
  [/\bBoto3?\//i, 'AWS SDK (Python)'],
  [/\baws-sdk/i, 'AWS SDK'],
];

const PLATFORMS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b|\bdarwin\b/i, 'macOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b|\blinux\b/, 'Linux'],
];

/**
 * Reduce a User-Agent header to "<client> on <platform>" (e.g. "Chrome on macOS").
 * Only known labels are ever returned, so nothing attacker-controlled (and no
 * fingerprinting detail such as versions) is persisted. `undefined` when the
 * header is absent; "Unknown client" when nothing is recognised.
 */
function summarizeUserAgent(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  const client = CLIENTS.find(([re]) => re.test(raw))?.[1];
  const platform = PLATFORMS.find(([re]) => re.test(raw))?.[1];
  if (client && platform) return `${client} on ${platform}`;
  return client ?? (platform ? `Unknown client on ${platform}` : 'Unknown client');
}

/** The device details of the request that opens or renews a session slot. */
export function clientInfoOf(req: Pick<Request, 'headers' | 'ip'>): ClientInfo {
  return {
    userAgent: summarizeUserAgent(req.headers?.['user-agent']),
    ...(req.ip ? { ip: req.ip } : {}),
  };
}
