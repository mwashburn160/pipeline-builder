// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth 2.0 device authorization grant client (RFC 8628) — how the CLI signs in.
 *
 * The CLI asks the platform for a code, shows it (and opens the browser when it
 * can), then polls until the person approves in that browser. No password and no
 * long-lived token ever passes through the command line, shell history, `ps`
 * output or a CI log; the browser is where SSO, step-up and later MFA already
 * apply, so the terminal inherits all of it without implementing any of it.
 */

import { spawn } from 'child_process';
import type https from 'https';
import { sleep } from '@pipeline-builder/api-core';
import axios from 'axios';
import { printDebug } from './output-utils.js';

/** `POST /auth/device/code` — RFC 8628 §3.2. */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/** `POST /auth/device/token` on success — RFC 8628 §3.5. */
export interface DeviceTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  /** Present only when the device asked for one at `/code` (`auth pat`). */
  step_up_token?: string;
}

/** The RFC error body, plus the `interval` the platform sends with `slow_down`. */
interface DeviceErrorResponse {
  error?: string;
  error_description?: string;
  interval?: number;
}

/** Connection settings shared by both calls. */
export interface DeviceAuthTransport {
  url: string;
  httpsAgent: https.Agent;
  timeout: number;
}

/** Raised for every terminal outcome, so callers can print one clear message. */
export class DeviceAuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'DeviceAuthError';
  }
}

/** Ask the platform to open a device authorization. */
export async function requestDeviceCode(
  transport: DeviceAuthTransport,
  options: { stepUp?: boolean } = {},
): Promise<DeviceCodeResponse> {
  const codeUrl = `${transport.url}/api/auth/device/code`;
  printDebug('POST', { url: codeUrl });
  const response = await axios.post<DeviceCodeResponse>(
    codeUrl,
    { ...(options.stepUp ? { step_up: true } : {}) },
    {
      headers: { 'Content-Type': 'application/json', 'X-Pb-Client': 'cli' },
      httpsAgent: transport.httpsAgent,
      timeout: transport.timeout,
    },
  );
  const data = response.data;
  if (!data?.device_code || !data.user_code) {
    throw new DeviceAuthError('The platform did not return a device code.', 'invalid_response');
  }
  return data;
}

/**
 * Poll `/auth/device/token` until the browser decides, the code expires, or
 * `signal` says to stop.
 *
 * Interval handling is the RFC's: start at the advertised `interval`, and widen
 * it by 5 seconds (or to whatever the platform names) on every `slow_down`. The
 * platform also enforces the interval, so a client that ignores it is throttled
 * rather than trusted.
 */
export async function pollForDeviceToken(
  transport: DeviceAuthTransport,
  code: DeviceCodeResponse,
  hooks: { onPending?: () => void } = {},
): Promise<DeviceTokenResponse> {
  const tokenUrl = `${transport.url}/api/auth/device/token`;
  const deadline = Date.now() + code.expires_in * 1000;
  let intervalMs = Math.max(1, code.interval) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    printDebug('POST', { url: tokenUrl });
    const response = await axios.post<DeviceTokenResponse & DeviceErrorResponse>(
      tokenUrl,
      { device_code: code.device_code },
      {
        headers: { 'Content-Type': 'application/json', 'X-Pb-Client': 'cli' },
        httpsAgent: transport.httpsAgent,
        timeout: transport.timeout,
        // The RFC's pending/backoff signals arrive as HTTP 400, which axios would
        // otherwise throw: they are protocol states, not failures.
        validateStatus: (status) => (status >= 200 && status < 300) || status === 400,
      },
    );

    if (response.status === 200) {
      if (!response.data?.access_token) {
        throw new DeviceAuthError('The platform approved the sign-in but returned no token.', 'invalid_response');
      }
      return response.data;
    }

    switch (response.data?.error) {
      case 'authorization_pending':
        hooks.onPending?.();
        break;
      case 'slow_down':
        intervalMs = Math.max(intervalMs + 5_000, (response.data.interval ?? 0) * 1000);
        printDebug('Polling slowed by the platform', { intervalMs });
        break;
      case 'access_denied':
        throw new DeviceAuthError('The sign-in was denied in the browser.', 'access_denied');
      case 'expired_token':
        throw new DeviceAuthError('The sign-in code expired before it was approved.', 'expired_token');
      default:
        throw new DeviceAuthError(
          response.data?.error_description || 'The platform refused the device sign-in.',
          response.data?.error || 'invalid_request',
        );
    }
  }

  throw new DeviceAuthError('Timed out waiting for the sign-in to be approved.', 'expired_token');
}

/** The OS command that opens a URL in the default browser. */
function openCommand(): { command: string; args: string[] } | null {
  if (process.platform === 'darwin') return { command: 'open', args: [] };
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] };
  if (process.platform === 'linux') return { command: 'xdg-open', args: [] };
  return null;
}

/**
 * Try to open `url` in the default browser. Returns false — never throws — when
 * the environment has no browser to open (a CI runner, an SSH session, a
 * non-interactive shell) or the opener isn't installed, so the caller falls back
 * to printing the URL.
 *
 * The URL is passed as an ARGUMENT, never through a shell, and only http(s) is
 * accepted: the value comes from the platform's response, and handing an
 * arbitrary scheme to the OS opener is how "click this link" turns into "run
 * this program".
 */
export function openInBrowser(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (process.env.CI || process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (!process.stdout.isTTY) return false;

  const opener = openCommand();
  if (!opener) return false;

  try {
    const child = spawn(opener.command, [...opener.args, url], { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser here; the printed URL is the fallback */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
