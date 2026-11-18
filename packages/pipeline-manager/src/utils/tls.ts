// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import https from 'https';
import { platformCaList } from '@pipeline-builder/pipeline-core';

/**
 * The https.Agent for a call to the platform: Node's roots plus a private CA
 * from `PLATFORM_CA_BUNDLE` when one is set (pipeline-core platform-tls), and
 * verification off only when `rejectUnauthorized` is explicitly `false`. Every
 * platform call goes through it — the API client, the credential commands,
 * the inline login and the session renewal — so a private-CA platform is
 * trusted by all of them, not only the API client.
 */
export function platformHttpsAgent(rejectUnauthorized: boolean | undefined): https.Agent {
  const ca = platformCaList();
  return new https.Agent({ rejectUnauthorized: rejectUnauthorized ?? true, ...(ca && { ca }) });
}

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
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local')) return true;
  // WHATWG URL keeps the brackets on an IPv6 host, so loopback reads `[::1]`.
  if (hostname === '[::1]') return true;
  // Private ranges only as a literal IPv4 address: a prefix test alone also
  // matched DNS names like `10.example.com`, turning verification off for a
  // host anyone can register.
  const octets = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (!octets) return false;
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
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

/**
 * Single source of truth for "is this a production run?" — the whole CLI keys its
 * TLS-disable refusal off `NODE_ENV=production`. Centralized here (rather than a
 * bare `process.env.NODE_ENV === 'production'` copied into config-loader, login,
 * platform-secret and the renew handler) so the policy can't drift between the
 * paths that transmit passwords/JWTs and the paths that merely read config.
 */
export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Guard for the credential-transmitting SSL-disable paths (login, inline-login,
 * token renewal, and every authenticated command via `getConfigWithOptions`).
 *
 * When a caller asks to disable certificate verification AND the run is
 * production, this THROWS a clear error rather than silently proceeding — a MITM
 * on a "prod with --no-verify-ssl" run would otherwise harvest the very
 * passwords/JWTs these paths send. In non-production it is a no-op, so
 * `--no-verify-ssl` / `PLATFORM_TLS_VERIFY=false` still work against self-signed
 * dev platforms.
 *
 * @param context - short description of the path being guarded, for the message.
 * @throws Error in production; returns `void` otherwise.
 */
export function assertSslDisableAllowed(context?: string): void {
  if (isProductionEnv()) {
    throw new Error(
      `Refusing to disable TLS certificate verification in production (NODE_ENV=production)${context ? ` — ${context}` : ''}. `
      + 'Credentials and tokens must never be transmitted over an unverified TLS connection. '
      + 'Use a platform with a valid certificate, or unset NODE_ENV for local/self-signed development.',
    );
  }
}

/**
 * Apply the `--no-verify-ssl` relaxation as a process-wide env flag
 * (`NODE_TLS_REJECT_UNAUTHORIZED=0`) so the spawned CDK app inherits it (and
 * pipeline-core carries it into every CodeBuild step) — but REFUSE in production, mirroring the guard in
 * config-loader. That flag disables certificate validation for ALL outbound TLS
 * (including the AWS SDK), so it must never be silently enabled for a prod
 * deploy/synth.
 *
 * @param verifySsl - the command's `--verify-ssl` value (`false` = user asked to disable).
 * @param warn - warning sink (e.g. `printWarning`).
 * @returns true if verification was disabled; false if left enabled.
 */
export function relaxTlsForCli(
  verifySsl: boolean | undefined,
  warn: (message: string) => void,
): boolean {
  if (verifySsl !== false) return false;
  if (isProductionEnv()) {
    warn('Refusing to disable TLS verification in production (NODE_ENV=production) — certificate validation remains enabled.');
    return false;
  }
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return true;
}
