// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential files that must never ride inside an uploaded plugin ZIP. The
 * catalog of kinds is api-core's `SECRET_FILE_KINDS`, shared with the CLI's
 * packer (which refuses to pack them before upload); this is the upload's
 * refusal for an archive built some other way, naming the file. Some kinds are
 * decided by the entry name alone; the rest (a private key under any name, a
 * service-account JSON, a token-bearing `.npmrc` / `.yarnrc.yml` / `pip.conf` /
 * Cargo or `gh` credentials, a Maven `settings.xml` password, …) by the entry's
 * leading content, which the extraction captures for nearly every entry.
 */

import {
  SECRET_FILE_CONTENT_SCAN_BYTES, SECRET_FILE_KINDS, secretFileKind, secretFileNeedsContent,
  type SecretFileKindKey,
} from '@pipeline-builder/api-core';

import type { ZipEntryScreen } from './zip-extract.js';

function refusal(fileName: string, kind: SecretFileKindKey): string {
  return `ZIP entry ${fileName} looks like a ${SECRET_FILE_KINDS[kind].label} — remove credentials from the plugin `
    + 'directory before packaging (pass secrets through the plugin spec `secrets` instead)';
}

/** Refusal message for a credential entry decided by its name, or null when the name allows it. */
export function secretFileProblem(fileName: string): string | null {
  const kind = secretFileKind(fileName);
  return kind ? refusal(fileName, kind) : null;
}

/** Refusal message for a content-decided credential entry, or null when its content is harmless. */
export function secretFileContentProblem(fileName: string, text: string): string | null {
  const kind = secretFileKind(fileName, text);
  return kind ? refusal(fileName, kind) : null;
}

/** The upload's per-entry credential screen (name first; content for the entries the name cannot decide). */
export const SECRET_FILE_SCREEN: ZipEntryScreen = {
  byName: secretFileProblem,
  wantsContent: secretFileNeedsContent,
  byContent: secretFileContentProblem,
  contentBytes: SECRET_FILE_CONTENT_SCAN_BYTES,
};
