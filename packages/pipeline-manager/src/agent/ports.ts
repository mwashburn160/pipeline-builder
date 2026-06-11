// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-port pre-flight. Local (Docker-published) and minikube (kubectl
 * port-forward) deploys bind fixed ports on the operator's machine; if one is
 * already taken, the container/forward fails to bind — and for the gateway that
 * surfaces as a silent "/health never reachable" hang. We probe the ports up
 * front so provision can stop with a clear summary instead of failing mid-deploy.
 */

import net from 'net';
import type { TargetSpec } from './targets.js';

export interface PortCheck {
  readonly service: string;
  readonly port: number;
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

/** Probe every host port a target binds; returns one PortCheck per port. */
export async function checkHostPorts(spec: TargetSpec): Promise<PortCheck[]> {
  return Promise.all(
    spec.hostPorts.map(async ({ service, port }) => ({ service, port, available: await isPortFree(port) })),
  );
}
