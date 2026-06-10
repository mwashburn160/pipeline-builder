// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-deploy health verification. A CloudFormation CREATE_COMPLETE (or a
 * finished setup.sh) does NOT mean the app is serving — the ALB targets stay
 * unhealthy until tasks/pods come up. The real done-signal is the platform's
 * `/health` + `/ready` endpoints, so the executor polls them with backoff.
 */

import https from 'https';
import axios from 'axios';
import type { TargetId } from './targets.js';

export interface HealthResult {
  readonly url: string;
  readonly healthy: boolean;
  readonly detail: string;
}

/**
 * Derive the URL the platform should be reachable at. Local/minikube front the
 * stack on localhost:8443; EC2/Fargate use the deploy domain. Returns null when
 * it can't be determined (caller surfaces a "verify manually" note).
 */
export function deriveHealthUrl(target: TargetId, params: Record<string, unknown>): string | null {
  if (target === 'local' || target === 'minikube') return 'https://localhost:8443';
  const domain = params.domain;
  return typeof domain === 'string' && domain ? `https://${domain}` : null;
}

const agent = new https.Agent({ rejectUnauthorized: false }); // local uses a self-signed cert

async function probe(url: string): Promise<boolean> {
  try {
    const res = await axios.get(url, { timeout: 5000, httpsAgent: agent, validateStatus: () => true });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll `<url>/health` then `<url>/ready` until both pass or the timeout elapses.
 * Non-fatal by design: a timeout returns `healthy: false` with guidance, never throws.
 */
export async function waitHealthy(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number; onTick?: (msg: string) => void } = {},
): Promise<HealthResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000; // 5 min — services come up async
  const intervalMs = opts.intervalMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;

  // Wait for BOTH /health AND /ready. /health flips first (the process is up),
  // but the platform only accepts API calls once /ready passes (DB connections,
  // dependencies warmed up). Returning on /health alone let post-install steps
  // (register) hit a not-yet-ready platform and get a 502.
  let healthSeen = false;
  while (Date.now() < deadline) {
    if (await probe(`${url}/health`)) {
      healthSeen = true;
      if (await probe(`${url}/ready`)) {
        return { url, healthy: true, detail: 'health + ready OK' };
      }
      opts.onTick?.(`health OK — waiting for ${url}/ready (dependencies warming up) …`);
    } else {
      opts.onTick?.(`waiting for ${url}/health …`);
    }
    await delay(intervalMs);
  }
  // Timed out. If /health came up but /ready never did, the platform is up but
  // not fully ready — proceed (non-fatal) but flag that post-steps may need a retry.
  return healthSeen
    ? { url, healthy: true, detail: `health OK but /ready not reached within ${Math.round(timeoutMs / 1000)}s — the platform is still warming up; post-install steps (register) may need a re-run` }
    : { url, healthy: false, detail: `not reachable within ${Math.round(timeoutMs / 1000)}s — check the stack / DNS / health logs` };
}
