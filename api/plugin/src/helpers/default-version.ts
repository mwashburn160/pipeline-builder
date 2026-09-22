// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which uploaded version becomes a plugin's DEFAULT — the version a pipeline
 * gets when it names the plugin without a version spec (
 * ). One pure rule, applied both by the unlocked upload pre-check
 * (`assertDeployable`) and under the deploy lock (`deployVersion`), so the two
 * can't disagree.
 *
 * An upload takes over as the default only when that can't surprise anyone
 * already relying on the default:
 *   - there is no live default yet (the first version of a plugin), or
 *   - it IS the current default (a re-upload of that same version), or
 *   - it is a STABLE version in the SAME major as the current default and
 *     newer than it (a patch/minor release).
 * A new major never auto-promotes — the default only crosses a major when
 * someone promotes it explicitly. A prerelease or an older version never takes
 * over either.
 */

import { compareSemverParts, parseSemver } from '@pipeline-builder/pipeline-data';

/** The version a plugin whose spec names none is stored under (every upload path and the deploy). */
export const DEFAULT_PLUGIN_VERSION = '0.0.0';

export function shouldBecomeDefault(
  version: string,
  isAlreadyDefault: boolean,
  currentDefaults: ReadonlyArray<{ version: string }>,
): boolean {
  if (isAlreadyDefault || currentDefaults.length === 0) return true;
  const incoming = parseSemver(version);
  if (!incoming || incoming.prerelease.length > 0) return false;
  // Several live defaults can only exist transiently (the deploy lock prevents
  // it); compare against the highest so the rule stays monotonic.
  const current = currentDefaults
    .map((d) => parseSemver(d.version))
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .sort(compareSemverParts)
    .pop();
  if (!current) return true;
  return incoming.major === current.major && compareSemverParts(incoming, current) > 0;
}
