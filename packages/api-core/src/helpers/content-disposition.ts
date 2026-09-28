// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `Content-Disposition: attachment` for a download whose file name is built
 * from stored or request data (a plugin name, a version, a report period). Every
 * character outside `[A-Za-z0-9._-]` becomes `_`, so a quote, a CR/LF or a
 * path separator can never break out of the header or the file name.
 *
 * In api-core rather than in one service because it is a header-injection guard with
 * several callers (plugin's SBOM and scan downloads, reporting's report PDFs). A second
 * copy of a sanitizer is a copy that gets a fix the other one does not.
 */

/** A header-safe file name (at most 200 characters, never empty). */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 200);
  return cleaned || 'download';
}

/** The full header value for downloading `name` as an attachment. */
export function attachmentDisposition(name: string): string {
  return `attachment; filename="${safeFileName(name)}"`;
}
