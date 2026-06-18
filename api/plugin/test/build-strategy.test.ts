// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-buildType build strategies (helpers/build-strategy).
 *
 * Only docker-build is mocked (so the strategy module loads without the real
 * buildkit/crane/Config chain). api-core (ValidationError) + safe-path are real;
 * pipeline-core / plugin-helpers are type-only here, so nothing to mock.
 */

import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'fs';
import os from 'os';
import path from 'path';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';

// macOS realpath()s os.tmpdir() (/var → /private/var); the strategy compares the
// Dockerfile's realpath against extractDir, so canonicalize the temp dir to match.
const mkTmp = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-')));

const buildAndPush = jest.fn<(...a: any[]) => Promise<{ fullImage: string }>>(async () => ({ fullImage: 'registry/built:1.0.0' }));
const loadAndPush = jest.fn<(...a: any[]) => Promise<{ fullImage: string }>>(async () => ({ fullImage: 'registry/loaded:1.0.0' }));

jest.unstable_mockModule('../src/helpers/docker-build.js', () => ({
  buildAndPush,
  loadAndPush,
  BUILD_TEMP_ROOT: '/tmp',
}));

const { getBuildStrategy } = await import('../src/helpers/build-strategy.js');

const ctx = (extractDir: string, over: Record<string, unknown> = {}) => ({
  extractDir,
  config: {},
  pluginSpec: { name: 'p', version: '1.0.0', commands: ['x'] } as any,
  isApprovalStep: false,
  ...over,
});
const req = (contextDir: string, buildType: string) => ({
  contextDir, name: 'p', version: '1.0.0', orgId: 'o', registry: {} as any, dockerfile: '', buildType,
} as any);

describe('getBuildStrategy', () => {
  it('maps each buildType to a strategy with the right flags', () => {
    expect(getBuildStrategy('build_image')).toMatchObject({ buildType: 'build_image', producesImage: true, allowsDockerfile: true });
    expect(getBuildStrategy('prebuilt')).toMatchObject({ buildType: 'prebuilt', producesImage: true, allowsDockerfile: false });
    expect(getBuildStrategy('metadata_only')).toMatchObject({ buildType: 'metadata_only', producesImage: false, allowsDockerfile: false });
  });
  it('throws on an unknown buildType', () => {
    expect(() => getBuildStrategy('nope' as any)).toThrow('Unknown buildType "nope"');
  });
});

describe('build_image strategy', () => {
  let dir: string;
  beforeAll(() => { dir = mkTmp(); writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch'); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves the default Dockerfile and reads its content', async () => {
    const r = await getBuildStrategy('build_image').validateAndResolve(ctx(dir));
    expect(r).toEqual({ dockerfile: 'Dockerfile', dockerfileContent: 'FROM scratch' });
  });
  it('skips Dockerfile resolution for approval steps', async () => {
    const r = await getBuildStrategy('build_image').validateAndResolve(ctx(dir, { isApprovalStep: true }));
    expect(r).toEqual({ dockerfile: '', dockerfileContent: null });
  });
  it('rejects a path-traversal Dockerfile', async () => {
    await expect(getBuildStrategy('build_image').validateAndResolve(ctx(dir, { config: { dockerfile: '../x' } })))
      .rejects.toThrow(/path traversal/);
  });
  it('produceImage awaits the (lazy) buildkit addr and delegates to buildAndPush', async () => {
    const strat = getBuildStrategy('build_image');
    if (!strat.producesImage) throw new Error('expected an image strategy');
    const getBuildkitAddr = jest.fn<() => Promise<string>>(async () => 'unix:///run/buildkit');
    const res = await strat.produceImage(req(dir, 'build_image'), { getBuildkitAddr });
    expect(getBuildkitAddr).toHaveBeenCalledTimes(1);
    expect(buildAndPush).toHaveBeenCalledWith(expect.objectContaining({ name: 'p' }), { buildkitAddr: 'unix:///run/buildkit' });
    expect(res.fullImage).toContain('built');
  });
});

describe('prebuilt strategy', () => {
  it('requires image.tar at validate time', async () => {
    const dir = mkTmp();
    await expect(getBuildStrategy('prebuilt').validateAndResolve(ctx(dir)))
      .rejects.toThrow('image.tar is required in ZIP when buildType is prebuilt');
    writeFileSync(path.join(dir, 'image.tar'), 'x');
    await expect(getBuildStrategy('prebuilt').validateAndResolve(ctx(dir)))
      .resolves.toEqual({ dockerfile: '', dockerfileContent: null });
    rmSync(dir, { recursive: true, force: true });
  });
  it('produceImage uses loadAndPush and NEVER touches the buildkit addr (lazy skip)', async () => {
    const dir = mkTmp(); writeFileSync(path.join(dir, 'image.tar'), 'x');
    const strat = getBuildStrategy('prebuilt');
    if (!strat.producesImage) throw new Error('expected an image strategy');
    const getBuildkitAddr = jest.fn<() => Promise<string>>(async () => 'unix:///run/buildkit');
    await strat.produceImage(req(dir, 'prebuilt'), { getBuildkitAddr });
    expect(getBuildkitAddr).not.toHaveBeenCalled();   // the lazy tier/quota win
    expect(loadAndPush).toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('metadata_only strategy', () => {
  it('produces no image and validates as a no-op', async () => {
    const strat = getBuildStrategy('metadata_only');
    expect(strat.producesImage).toBe(false);
    const dir = mkTmp();
    await expect(strat.validateAndResolve(ctx(dir))).resolves.toEqual({ dockerfile: '', dockerfileContent: null });
    rmSync(dir, { recursive: true, force: true });
  });
});
