// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_REF,
  DEFAULT_REPO,
  DEFAULT_WORKDIR,
  bootstrapCommand,
  resolveBootstrap,
} from '../src/agent/bootstrap.js';

describe('resolveBootstrap', () => {
  it('fills defaults when inputs are empty/absent', () => {
    const spec = resolveBootstrap({}, ['deploy/bin', 'deploy/local']);
    expect(spec.repo).toBe(DEFAULT_REPO);
    expect(spec.ref).toBe(DEFAULT_REF);
    expect(spec.workdir).toBe(DEFAULT_WORKDIR);
    expect(spec.paths).toEqual(['deploy/bin', 'deploy/local']);
    expect(spec.full).toBe(false);
  });

  it('honours overrides and trims whitespace', () => {
    const spec = resolveBootstrap({ repo: ' https://x/y.git ', ref: ' v1 ', workdir: ' wd ', full: true }, ['deploy/bin']);
    expect(spec.repo).toBe('https://x/y.git');
    expect(spec.ref).toBe('v1');
    expect(spec.workdir).toBe('wd');
    expect(spec.full).toBe(true);
  });
});

describe('bootstrapCommand (sparse, partial)', () => {
  const spec = resolveBootstrap({ workdir: 'pb', ref: 'main' }, ['deploy/bin', 'deploy/local', 'deploy/plugins']);
  const cmd = bootstrapCommand(spec);

  it('partial-clones with blob filter + no-checkout + cone set on a fresh dir', () => {
    expect(cmd).toContain('git clone --filter=blob:none --no-checkout --depth 1');
    expect(cmd).toContain("sparse-checkout set --cone 'deploy/bin' 'deploy/local' 'deploy/plugins'");
  });

  it('is additive on an existing checkout (add, not set, so prior targets persist)', () => {
    expect(cmd).toContain("[ -d 'pb'/.git ]");
    expect(cmd).toContain("sparse-checkout add 'deploy/bin' 'deploy/local' 'deploy/plugins'");
    expect(cmd).toContain('fetch --filter=blob:none --depth 1 origin');
  });

  it('single-quotes interpolated values (injection-safe)', () => {
    const evil = bootstrapCommand(resolveBootstrap({ ref: "x'; rm -rf /" }, ['deploy/bin']));
    expect(evil).toContain("'x'\\''; rm -rf /'");
    expect(evil).not.toMatch(/checkout x'; rm/);
  });

  it('falls back to a plain full clone when full=true (git < 2.27)', () => {
    const full = bootstrapCommand(resolveBootstrap({ full: true }, ['deploy/bin']));
    expect(full).toContain('git clone');
    expect(full).not.toContain('--filter=blob:none');
    expect(full).not.toContain('sparse-checkout');
  });
});
