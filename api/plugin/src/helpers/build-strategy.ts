// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build strategies — one per plugin `buildType`, behind a runtime factory.
 *
 * Consolidates the two concerns that used to be scattered across plugin-spec.ts,
 * plugin-build-queue.ts and upload-plugin.ts as inline `buildType ===` branches:
 *   - validate + resolve   (what the extracted ZIP must contain)
 *   - produce the image     (how to build/push it — or not, for metadata_only)
 *
 * A `metadata_only` plugin produces no image, modelled with a discriminated union so
 * `if (strat.producesImage)` narrows to `ImageBuildStrategy` — no throwing stub.
 *
 * NOTE: `isApprovalStep` (pluginType `ManualApprovalStep`) is a SECOND, orthogonal
 * "skip build" axis handled by the callers, not by the strategy — but it's passed in
 * so build_image skips Dockerfile resolution for approval steps (as it did before).
 */

import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import path from 'path';

import { ValidationError } from '@pipeline-builder/api-core';
import type { PluginSpec } from '@pipeline-builder/pipeline-core';

import { buildAndPush, loadAndPush } from './docker-build.js';
import type { BuildRequest, BuildResult, BuildType } from './docker-build.js';
import type { PluginConfig } from './plugin-helpers.js';
import { validateSafePath } from './safe-path.js';

export interface BuildValidateCtx {
  extractDir: string;
  config: PluginConfig;
  pluginSpec: PluginSpec;
  isApprovalStep: boolean;
}

export interface ResolvedDockerfile {
  /** Validated Dockerfile path relative to extractDir ('' when none). */
  dockerfile: string;
  /** Raw Dockerfile content (for DB storage), or null when none. */
  dockerfileContent: string | null;
}

export interface BuildDeps {
  /**
   * Resolve the buildkit address for this build. LAZY on purpose — only build_image
   * awaits it, so prebuilt (a crane push) never pays for the tier/quota-service lookup.
   */
  getBuildkitAddr(): Promise<string>;
}

interface BaseBuildStrategy {
  readonly buildType: BuildType;
  /** Whether a Dockerfile is permitted for this build type. */
  readonly allowsDockerfile: boolean;
  /**
   * Validate the extracted ZIP for this build type AND resolve its Dockerfile.
   * Throws `ValidationError` on bad input.
   */
  validateAndResolve(ctx: BuildValidateCtx): Promise<ResolvedDockerfile>;
}

/** A build type that produces + pushes a container image. */
export interface ImageBuildStrategy extends BaseBuildStrategy {
  readonly producesImage: true;
  produceImage(req: BuildRequest, deps: BuildDeps): Promise<BuildResult>;
}

/** A build type that produces no image (metadata_only). */
export interface NoImageBuildStrategy extends BaseBuildStrategy {
  readonly producesImage: false;
}

export type BuildStrategy = ImageBuildStrategy | NoImageBuildStrategy;

const buildImageStrategy: ImageBuildStrategy = {
  buildType: 'build_image',
  allowsDockerfile: true,
  producesImage: true,
  async validateAndResolve(ctx) {
    // Approval steps carry no Dockerfile even when build_image is the default.
    if (ctx.isApprovalStep) return { dockerfile: '', dockerfileContent: null };

    const rawDockerfile = ctx.config.dockerfile ?? ctx.pluginSpec.dockerfile ?? 'Dockerfile';
    const dockerfile = validateSafePath('dockerfile', rawDockerfile);

    const dockerfilePath = path.join(ctx.extractDir, dockerfile);
    const realDockerfilePath = existsSync(dockerfilePath)
      ? await fs.realpath(dockerfilePath)
      : null;

    if (realDockerfilePath && !realDockerfilePath.startsWith(ctx.extractDir + path.sep)) {
      throw new ValidationError('Invalid dockerfile path: resolves outside extraction directory');
    }

    const dockerfileContent = realDockerfilePath
      ? await fs.readFile(realDockerfilePath, 'utf-8')
      : null;
    return { dockerfile, dockerfileContent };
  },
  async produceImage(req, deps) {
    const buildkitAddr = await deps.getBuildkitAddr();
    return buildAndPush(req, { buildkitAddr });
  },
};

const prebuiltStrategy: ImageBuildStrategy = {
  buildType: 'prebuilt',
  allowsDockerfile: false,
  producesImage: true,
  async validateAndResolve(ctx) {
    if (!existsSync(path.join(ctx.extractDir, 'image.tar'))) {
      throw new ValidationError('image.tar is required in ZIP when buildType is prebuilt');
    }
    return { dockerfile: '', dockerfileContent: null };
  },
  async produceImage(req) {
    const tarPath = path.join(req.contextDir, 'image.tar');
    if (!existsSync(tarPath)) {
      throw new Error('Prebuilt plugin is missing image.tar in ZIP archive');
    }
    return loadAndPush(tarPath, req.name, req.version, req.registry, req.orgId);
  },
};

const metadataOnlyStrategy: NoImageBuildStrategy = {
  buildType: 'metadata_only',
  allowsDockerfile: false,
  producesImage: false,
  async validateAndResolve() {
    return { dockerfile: '', dockerfileContent: null };
  },
};

const STRATEGIES: Record<BuildType, BuildStrategy> = {
  build_image: buildImageStrategy,
  prebuilt: prebuiltStrategy,
  metadata_only: metadataOnlyStrategy,
};

export function getBuildStrategy(buildType: BuildType): BuildStrategy {
  const strategy = STRATEGIES[buildType];
  if (!strategy) throw new Error(`Unknown buildType "${buildType}"`);
  return strategy;
}
