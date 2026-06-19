// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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

  it('ec2 / eks: no host ports (CloudFormation binds nothing locally)', () => {
    expect(discoverHostPorts('ec2', repoRoot, TARGETS.ec2)).toEqual([]);
    expect(discoverHostPorts('eks', repoRoot, TARGETS.eks)).toEqual([]);
  });

  it('falls back to the static hostPorts when the source file is missing', () => {
    expect(discoverHostPorts('docker', '/no/such/dir', TARGETS.docker))
      .toEqual(TARGETS.docker.hostPorts.map((p) => ({ ...p })));
  });
});
