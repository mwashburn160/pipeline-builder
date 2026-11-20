// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential files that must never ride inside an uploaded plugin ZIP. The
 * catalog of kinds is api-core's `SECRET_FILE_KINDS`, shared with the CLI's
 * packer (which refuses to pack them before upload); this is the upload's
 * refusal for an archive built some other way, naming the file.
 */

import { SECRET_FILE_KINDS, secretFileKind } from '@pipeline-builder/api-core';

/** Refusal message for a credential entry, or null when the entry is allowed. */
export function secretFileProblem(fileName: string): string | null {
  const kind = secretFileKind(fileName);
  if (!kind) return null;
  return `ZIP entry ${fileName} looks like a ${SECRET_FILE_KINDS[kind].label} — remove credentials from the plugin `
    + 'directory before packaging (pass secrets through the plugin spec `secrets` instead)';
}
