// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The managed toolchain refusals (docs/plans/bootstrap-image-versioning.md §1,
 * §5, D5). `pipeline-bootstrap` and `cdk-synth` are one release published by
 * the system org:
 *
 * - only the system org creates rows with these names
 *   (403 PLUGIN_MANAGED_NAME_RESERVED);
 * - they are never listed: no publish request, submission, listing or install
 *   (400 PLUGIN_MANAGED_NOT_LISTABLE);
 * - a release version is plain semver (400 PLUGIN_MANAGED_PRERELEASE) and
 *   immutable once uploaded (409 PLUGIN_VERSION_IMMUTABLE, in `deployVersion`);
 * - their lifecycle lives in the Toolchain console, so every generic route that
 *   changes a version refuses them, for the system org too
 *   (400 TOOLCHAIN_USE_CONSOLE).
 */

import { AppError, ErrorCode, getStatusForErrorCode, isManagedToolchainPlugin, isSystemOrgId } from '@pipeline-builder/api-core';
import { parseSemver } from '@pipeline-builder/pipeline-data';

/** A version row's lifecycle facts (a cached row carries the timestamps as ISO strings). */
type LifecycleFacts = { yankedAt?: Date | string | null; deprecatedAt?: Date | string | null; lifecycle?: string | null };

/** Whether a version is yanked — by its timestamp or its lifecycle, either one. */
export function isYankedVersion(row: Pick<LifecycleFacts, 'yankedAt' | 'lifecycle'>): boolean {
  return Boolean(row.yankedAt) || row.lifecycle === 'yanked';
}

/** Whether a version is deprecated — by its timestamp or its lifecycle, either one. */
export function isDeprecatedVersion(row: Pick<LifecycleFacts, 'deprecatedAt' | 'lifecycle'>): boolean {
  return Boolean(row.deprecatedAt) || row.lifecycle === 'deprecated';
}

function refusal(code: ErrorCode, message: string, details?: Record<string, unknown>): AppError {
  return new AppError(getStatusForErrorCode(code), code, message, details);
}

/**
 * Refuse an upload of a managed name that the generic upload path must never
 * accept: from a non-system org, with a publish request, or as a prerelease.
 * A no-op for any other name. Checked in this order, so a tenant always hears
 * that the name is reserved.
 */
export function assertManagedUploadAllowed(
  orgId: string,
  name: string | null | undefined,
  version: string | null | undefined,
  opts: { publishRequest?: boolean } = {},
): void {
  if (!isManagedToolchainPlugin(name)) return;
  if (!isSystemOrgId(orgId)) {
    throw refusal(
      ErrorCode.PLUGIN_MANAGED_NAME_RESERVED,
      `"${name}" is a managed toolchain plugin name, reserved for the platform. Publish a custom synth environment under another name.`,
      { name },
    );
  }
  if (opts.publishRequest) {
    throw refusal(ErrorCode.PLUGIN_MANAGED_NOT_LISTABLE, `"${name}" is a managed toolchain plugin and is never listed in the ecosystem; upload it without publishRequest.`, { name });
  }
  const parsed = version ? parseSemver(version) : null;
  if (parsed && parsed.prerelease.length > 0) {
    throw refusal(
      ErrorCode.PLUGIN_MANAGED_PRERELEASE,
      `${name}@${version} is a prerelease; a managed toolchain release version is plain semver (MAJOR.MINOR.PATCH).`,
      { name, version },
    );
  }
}

/** Refuse a managed name in a publish, submission, listing or install path. */
export function assertListable(name: string | null | undefined): void {
  if (isManagedToolchainPlugin(name)) {
    throw refusal(ErrorCode.PLUGIN_MANAGED_NOT_LISTABLE, `"${name}" is a managed toolchain plugin and is never listed in the ecosystem.`, { name });
  }
}

/** The refusal a generic version route answers for a managed name (any org, the system org included). */
export function toolchainUseConsoleError(name: string): AppError {
  return refusal(
    ErrorCode.TOOLCHAIN_USE_CONSOLE,
    `"${name}" is a managed toolchain plugin; its releases (default, deprecate, yank, delete) are managed in the Toolchain console.`,
    { name },
  );
}

/** Refuse a generic version-lifecycle route (update, deprecate/yank, delete, purge) on a managed name. */
export function assertNotManaged(name: string | null | undefined): void {
  if (isManagedToolchainPlugin(name)) throw toolchainUseConsoleError(name);
}
