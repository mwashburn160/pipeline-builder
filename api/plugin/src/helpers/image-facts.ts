// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What the build worker establishes about a freshly pushed, signed image
 * before the version is persisted: its vulnerability scan (grype over
 * the signed SBOM), whether it runs as root, and — with those real facts — the
 * post-build compliance check the upload deferred.
 */

import { AppError, ErrorCode, createComplianceClient, createLogger, errorMessage, getServiceAuthHeader, parseDockerfile } from '@pipeline-builder/api-core';

import { postBuildComplianceAttributes } from './plugin-compliance.js';
import type { PluginRecordData } from './plugin-helpers.js';
import type { RegistryInfo } from './registry-auth.js';
import type { PluginImageRef } from './supply-chain.js';
import { inspectRunAsRoot, isRootUser, scanColumns, scanPluginImage, type ScanColumns } from './vuln-scan.js';

const logger = createLogger('image-facts');

const complianceClient = createComplianceClient();

/** The image facts persisted with the version. */
export interface ImageFacts extends ScanColumns {
  runAsRoot: boolean | null;
  /** SBOM package names (for the compliance check only; not a column). */
  packages: string[] | null;
}

/**
 * Whether the image runs as root: from the pushed image's config `User` (what
 * actually runs, base-image USER included); if the config can't be read, from
 * the Dockerfile's own final `USER`; unknown (`null`) when neither says.
 */
export async function resolveRunAsRoot(ref: PluginImageRef, registry: RegistryInfo, dockerfile: string | null): Promise<boolean | null> {
  try {
    return await inspectRunAsRoot(ref, registry);
  } catch (err) {
    const user = parseDockerfile(dockerfile).finalUser;
    logger.warn('Image config unreadable; runAsRoot from the Dockerfile', {
      orgId: ref.orgId, name: ref.name, error: errorMessage(err), dockerfileUser: user !== null,
    });
    return user !== null ? isRootUser(user) : null;
  }
}

/**
 * Scan the pushed image and resolve its USER. Never throws: an unscannable
 * image lands as UNSCANNED (all scan columns NULL — compliance then sees
 * `scanned: false`), never as a fake clean scan.
 */
export async function establishImageFacts(ref: PluginImageRef, registry: RegistryInfo, dockerfile: string | null): Promise<ImageFacts> {
  const { scan, packages } = await scanPluginImage(ref, registry, 'build', { refreshDb: true });
  const runAsRoot = await resolveRunAsRoot(ref, registry, dockerfile);
  return { ...scanColumns(scan), runAsRoot, packages };
}

/**
 * The post-build compliance check: the upload deferred every image fact, so the
 * rules reading `signed` / `scanned` / `vuln*` / `runAsRoot` / `packages` are
 * evaluated HERE, before the version is persisted. A block throws a 403
 * `COMPLIANCE_VIOLATION` AppError (a permanent build failure — the slot is
 * refunded and nothing is deployed); an unreachable compliance service throws
 * a plain error (retryable), fail-closed.
 */
export async function assertPostBuildCompliance(
  orgId: string,
  record: PluginRecordData,
  imageDigest: string,
  facts: ImageFacts,
): Promise<void> {
  const derived = postBuildComplianceAttributes({ ...record, ...facts, imageDigest }, facts.packages);
  const authHeader = getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });
  const result = await complianceClient.validatePlugin(orgId, {
    name: record.name,
    version: record.version,
    pluginType: record.pluginType,
    computeType: record.computeType,
    timeout: record.timeout,
    failureBehavior: record.failureBehavior,
    env: record.env,
    buildArgs: record.buildArgs,
    installCommands: record.installCommands,
    commands: record.commands,
    visibility: record.visibility,
    secrets: record.secrets,
    metadata: record.metadata,
    keywords: record.keywords,
    buildType: record.buildType,
    ...derived.attributes,
  }, authHeader, undefined, record.name, 'build', derived.deferredFields);
  if (result.blocked) {
    const names = result.violations.map((v) => v.ruleName || v.field).filter(Boolean).slice(0, 5).join(', ');
    throw new AppError(403, ErrorCode.COMPLIANCE_VIOLATION,
      `COMPLIANCE_VIOLATION: the built image failed compliance rules${names ? ` (${names})` : ''}`);
  }
}
