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

  while (Date.now() < deadline) {
    if (await probe(`${url}/health`)) {
      const ready = await probe(`${url}/ready`);
      return {
        url,
        healthy: true,
        detail: ready ? 'health + ready OK' : 'health OK (ready not yet — dependencies still warming up)',
      };
    }
    opts.onTick?.(`waiting for ${url}/health …`);
    await delay(intervalMs);
  }
  return { url, healthy: false, detail: `not reachable within ${Math.round(timeoutMs / 1000)}s — check the stack / DNS / health logs` };
}
