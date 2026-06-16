// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-port pre-flight. Local (Docker-published) and minikube (kubectl port-forward)
 * deploys bind fixed ports on the operator's machine; if one is already taken, the
 * container/forward fails to bind — and for the gateway that surfaces as a silent
 * "/health never reachable" hang. We probe the ports before deploying so provision
 * can stop with a clear summary instead of failing mid-deploy.
 *
 * The port list is DERIVED from each target's actual (cloned) deploy source — so it
 * can't drift from the deploy: local from `docker-compose.yml`'s published ports,
 * minikube from `setup.sh`'s kubectl port-forwards. ec2/eks deploy via
 * CloudFormation and bind NOTHING on the operator's machine (only the remote ALB),
 * so they yield no host ports. `targets.hostPorts` is only a fallback when the source
 * file can't be read.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import net from 'net';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import type { TargetId, TargetSpec } from './targets.js';

export interface HostPort {
  readonly service: string;
  readonly port: number;
}

export interface PortCheck extends HostPort {
  readonly available: boolean;
}

/** Try to bind <host>:<port>; true if free, false on EADDRINUSE/EACCES. */
function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/**
 * Is `port` free? Probes BOTH `0.0.0.0` (where Docker publishes `0.0.0.0:<port>`)
 * AND `127.0.0.1` (where kubectl port-forward / Docker Desktop bind), requiring both.
 *
 * This is NOT redundant — do not "simplify" to one bind. Verified empirically on
 * macOS (Node sets SO_REUSEADDR): neither interface subsumes the other. With a holder
 * on 127.0.0.1, binding 0.0.0.0 still SUCCEEDS (a single 0.0.0.0 probe would MISS a
 * port-forward squatting the gateway on loopback); with a holder on 0.0.0.0, binding
 * 127.0.0.1 still succeeds. Only checking both reliably catches the real conflict (a
 * port-forward on 8443, AirPlay on 5000, …). For a pre-flight, a false positive
 * (over-cautious) beats a false negative (miss it → the deploy fails mid-way).
 */
async function isPortFree(port: number): Promise<boolean> {
  const [allIfaces, loopback] = await Promise.all([canBind(port, '0.0.0.0'), canBind(port, '127.0.0.1')]);
  return allIfaces && loopback;
}

/**
 * Host (left-side) ports a docker-compose.yml publishes, keyed by service. Handles
 * the short forms "HOST:CONTAINER", "HOST:CONTAINER/proto", "IP:HOST:CONTAINER" and
 * the long form `{ published, target }`. Bare "CONTAINER" (random host port) is
 * skipped — it can't conflict on a fixed port.
 */
function composeHostPorts(file: string): HostPort[] {
  const doc = parseYaml(readFileSync(file, 'utf8')) as { services?: Record<string, { ports?: unknown[] }> };
  const out: HostPort[] = [];
  for (const [service, def] of Object.entries(doc?.services ?? {})) {
    for (const entry of def?.ports ?? []) {
      let host: number | undefined;
      if (typeof entry === 'string') {
        const parts = (entry.split('/')[0] ?? '').split(':'); // strip /proto, split ip:host:container
        if (parts.length >= 2) host = Number(parts[parts.length - 2] ?? ''); // host is second-from-last
      } else if (entry && typeof entry === 'object' && 'published' in entry) {
        host = Number((entry as { published: unknown }).published);
      }
      if (host !== undefined && Number.isInteger(host)) out.push({ service, port: host });
    }
  }
  return out;
}

/** Host ports from minikube setup.sh's `port_forward "Name" svc "HOST:CONTAINER …"` calls. */
function forwardHostPorts(file: string): HostPort[] {
  const out: HostPort[] = [];
  const re = /port_forward\s+"([^"]+)"\s+\S+\s+"([^"]+)"/g;
  const text = readFileSync(file, 'utf8');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const service = m[1] ?? '';
    for (const pair of (m[2] ?? '').trim().split(/\s+/)) {
      const host = Number(pair.split(':')[0] ?? '');
      if (Number.isInteger(host)) out.push({ service, port: host });
    }
  }
  return out;
}

/**
 * Derive the host ports a target binds from its ACTUAL (cloned) deploy source, so the
 * list can't drift from the deploy. local → docker-compose.yml; minikube → setup.sh;
 * ec2/eks → none (CloudFormation binds nothing on the operator's machine). Needs
 * the deploy files on disk (run post-clone); falls back to the target's static
 * `hostPorts` if the source is missing/unreadable.
 */
export function discoverHostPorts(target: TargetId, cwd: string, spec: TargetSpec): HostPort[] {
  try {
    if (target === 'local') return composeHostPorts(path.join(cwd, spec.dir, 'docker-compose.yml'));
    if (target === 'minikube') return forwardHostPorts(path.join(cwd, spec.dir, 'bin', 'setup.sh'));
    return []; // ec2/eks deploy remotely — nothing binds locally
  } catch {
    return spec.hostPorts.map((p) => ({ ...p }));
  }
}

/** Probe each host port; returns one PortCheck per port (probed in parallel). */
export async function checkHostPorts(ports: readonly HostPort[]): Promise<PortCheck[]> {
  return Promise.all(ports.map(async ({ service, port }) => ({ service, port, available: await isPortFree(port) })));
}

/**
 * Is the target's OWN deploy stack already running? (local docker-compose only.) Used
 * so the port pre-flight doesn't block an idempotent RE-RUN: if the "taken" ports are
 * held by the stack you already have up, `docker compose up` just no-ops them — that's
 * not a conflict. Read-only `docker compose ps`; false on any error / non-local target.
 */
export function stackRunning(target: TargetId, cwd: string, spec: TargetSpec): boolean {
  if (target !== 'local') return false;
  try {
    const compose = path.join(cwd, spec.dir, 'docker-compose.yml');
    const out = execSync(`docker compose -f '${compose}' ps -q`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 })
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    return false;
  }
}
