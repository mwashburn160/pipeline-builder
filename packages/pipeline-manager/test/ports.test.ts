// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { discoverHostPorts } from '../src/agent/ports.js';
import { TARGETS } from '../src/agent/targets.js';

// jest runs from packages/pipeline-manager → repo root is two levels up.
const repoRoot = path.resolve(process.cwd(), '..', '..');

describe('discoverHostPorts — derived from the real (checked-in) deploy source', () => {
  it('local: parses the published ports out of docker-compose.yml', () => {
    const ports = discoverHostPorts('docker', repoRoot, TARGETS.docker).map((p) => p.port).sort((a, b) => a - b);
    // The host (left-side) ports docker-compose.yml actually publishes.
    expect(ports).toEqual(expect.arrayContaining([5000, 5480, 8080, 8443, 16686, 27081]));
  });

  it('minikube: parses setup.sh port-forwards (8443 yes, 8080 no — we forward 8443 only)', () => {
    const ports = discoverHostPorts('minikube', repoRoot, TARGETS.minikube).map((p) => p.port);
    expect(ports).toContain(8443);
    expect(ports).toContain(5480);
    expect(ports).not.toContain(8080);
  });

  it('minikube: reads the SHARED helper, not just setup.sh', () => {
    // The forwards used to be duplicated in setup.sh and startup.sh and now live
    // once in deploy/bin/k8s-resources.sh. Parsing setup.sh alone returned ZERO
    // ports the moment that landed — the derived list went silently empty while
    // every port was still being forwarded.
    const helper = path.join(repoRoot, 'deploy', 'bin', 'k8s-resources.sh');
    expect(readFileSync(helper, 'utf8')).toContain('pb_console_port_forwards');
    const ports = discoverHostPorts('minikube', repoRoot, TARGETS.minikube).map((p) => p.port);
    // 9001 (RustFS console) and 16686 (Jaeger) exist ONLY in the shared helper.
    expect(ports).toEqual(expect.arrayContaining([8443, 5480, 3001, 20001, 9001, 16686]));
  });

  it('minikube: falls back to the static list when NO forward source is readable', () => {
    // The guard that makes an empty parse LOUD rather than reporting "no ports",
    // which is indistinguishable from a target that forwards nothing — exactly
    // how the regression above hid.
    const ports = discoverHostPorts('minikube', path.join(repoRoot, 'does-not-exist'), TARGETS.minikube);
    expect(ports).toEqual(TARGETS.minikube.hostPorts.map((p) => ({ ...p })));
    expect(ports.length).toBeGreaterThan(0);
  });

  it('ec2 / eks: no host ports (CloudFormation binds nothing locally)', () => {
    expect(discoverHostPorts('ec2', repoRoot, TARGETS.ec2)).toEqual([]);
    expect(discoverHostPorts('eks', repoRoot, TARGETS.eks)).toEqual([]);
  });

  it('falls back to the static hostPorts when the source file is missing', () => {
    expect(discoverHostPorts('docker', '/no/such/dir', TARGETS.docker))
      .toEqual(TARGETS.docker.hostPorts.map((p) => ({ ...p })));
  });
});
