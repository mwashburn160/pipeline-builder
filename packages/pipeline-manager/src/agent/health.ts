// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-deploy health verification. A CloudFormation CREATE_COMPLETE (or a
 * finished setup.sh) does NOT mean the app is serving — the ALB targets stay
 * unhealthy until tasks/pods come up. The real done-signal is the platform's
 * `/health` + `/ready` endpoints, so the executor polls them with backoff.
 */

import { spawn } from 'child_process';
import https from 'https';
import axios from 'axios';
import type { TargetId } from './targets.js';

export interface HealthResult {
  readonly url: string;
  readonly healthy: boolean;
  /**
   * True only when BOTH /health and /ready passed. Distinguishes a fully-ready
   * platform from the degraded "health OK but /ready never came, proceeding anyway"
   * state — both have healthy:true, so callers should style success on `ready`.
   */
  readonly ready: boolean;
  readonly detail: string;
}

/**
 * Derive the URL the platform should be reachable at. Local/minikube front the
 * stack on localhost:8443; EC2/EKS use the deploy domain. Returns null when
 * it can't be determined (caller surfaces a "verify manually" note).
 */
export function deriveHealthUrl(target: TargetId, params: Record<string, unknown>): string | null {
  if (target === 'docker' || target === 'minikube') return 'https://localhost:8443';
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
  opts: { timeoutMs?: number; intervalMs?: number; readyGraceMs?: number; onTick?: (msg: string) => void } = {},
): Promise<HealthResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000; // 5 min — services come up async
  const intervalMs = opts.intervalMs ?? 10_000;
  // Once /health is up, only wait this much longer for /ready before proceeding.
  const readyGraceMs = opts.readyGraceMs ?? 90_000; // 90s covers normal warmup
  const deadline = Date.now() + timeoutMs;

  // Wait for /health, then give /ready a BOUNDED grace window. /health flips first
  // (the process is up); /ready also requires every backend dependency to be up.
  // We prefer /ready (post-install register hits a not-yet-ready platform → 502),
  // but if a dependency is DOWN (e.g. a crash-looping service) /ready never flips —
  // so we must not block the full timeout on it. Once /health is up we wait at most
  // `readyGraceMs` more, then proceed with a warning (register only needs the
  // platform service, which /health already confirms is up).
  let healthSeenAt = 0;
  while (Date.now() < deadline) {
    if (await probe(`${url}/health`)) {
      if (healthSeenAt === 0) healthSeenAt = Date.now();
      if (await probe(`${url}/ready`)) {
        return { url, healthy: true, ready: true, detail: 'health + ready OK' };
      }
      const leftMs = readyGraceMs - (Date.now() - healthSeenAt);
      if (leftMs <= 0) {
        return {
          url,
          healthy: true,
          ready: false,
          detail: `health OK, but /ready didn't pass within ${Math.round(readyGraceMs / 1000)}s — a backend service is likely down (check \`docker compose ps\` / its logs). Continuing; routes for that service may 502 until it's healthy.`,
        };
      }
      opts.onTick?.(`Health OK — waiting up to ${Math.ceil(leftMs / 1000)}s for ${url}/ready (dependencies warming up) …`);
    } else {
      opts.onTick?.(`Waiting for ${url}/health …`);
    }
    await delay(intervalMs);
  }
  // Overall timeout. If /health came up but /ready never did, proceed (non-fatal).
  return healthSeenAt > 0
    ? { url, healthy: true, ready: false, detail: 'health OK but /ready not reached — the platform is still warming up; post-install steps (register) may need a re-run' }
    : { url, healthy: false, ready: false, detail: `not reachable within ${Math.round(timeoutMs / 1000)}s — check the stack / DNS / health logs` };
}

/**
 * Minikube only: the gateway (https://localhost:8443) is reached through a
 * `kubectl port-forward svc/nginx` that setup.sh backgrounds — which can die or
 * fail to bind (e.g. a busy port) while the pods stay healthy, leaving the gateway
 * unreachable so the health poll just times out. Before polling, probe the gateway;
 * if it's down, (re)start the forward DETACHED so it outlives this CLI, then give
 * it a moment to bind. Best-effort: never throws; on no-kubectl it logs the manual
 * command. (setup.sh now forwards 8443 only, so a busy 8080 can't take it down.)
 */
export async function ensureMinikubeGateway(
  url: string,
  opts: { ns?: string; port?: number; onInfo?: (msg: string) => void } = {},
): Promise<void> {
  const ns = opts.ns ?? 'pipeline-builder';
  const port = opts.port ?? 8443;
  if (await probe(`${url}/health`)) return; // forward already up — nothing to do
  opts.onInfo?.(`Gateway unreachable — (re)starting the nginx port-forward (svc/nginx ${port}:${port}, ns ${ns}) …`);
  // A missing kubectl surfaces as an async 'error' event (ENOENT), NOT a synchronous
  // throw — a try/catch would miss it and the unhandled event would crash the CLI. Attach
  // an 'error' listener so this stays best-effort (logs the manual command, never throws).
  const child = spawn('kubectl', ['port-forward', '-n', ns, 'svc/nginx', `${port}:${port}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {
    opts.onInfo?.(`Couldn't start it (is kubectl on PATH?). Start it manually: kubectl port-forward -n ${ns} svc/nginx ${port}:${port}`);
  });
  child.unref(); // detached + unref → survives this CLI so the user keeps the gateway
  await delay(2000); // let it bind before the caller polls
}
