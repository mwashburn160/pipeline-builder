// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What both plugin-ZIP upload routes (the authenticated `POST /plugins` and the
 * anonymous `/public/plugin-submissions`) accept from multer, in one place.
 */

/**
 * Multer's destination for the incoming multipart ZIP. The plugin container runs
 * with readOnlyRootFilesystem=true, so it is the per-pod build-scratch volume, not
 * a path under `/app`. The staged file is transient: each route removes it on every
 * outcome. Override via PLUGIN_UPLOAD_DIR (tests).
 */
export const UPLOAD_DEST = process.env.PLUGIN_UPLOAD_DIR || '/opt/pipeline/pipeline-data/plugins-data';

/** Content types a browser or CLI sends for a ZIP. */
export const ZIP_UPLOAD_MIME_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'] as const;

/** True when a multipart file part is a ZIP by content type or by its `.zip` name. */
export function isZipUpload(file: { mimetype: string; originalname: string }): boolean {
  return (ZIP_UPLOAD_MIME_TYPES as readonly string[]).includes(file.mimetype) || file.originalname.endsWith('.zip');
}
