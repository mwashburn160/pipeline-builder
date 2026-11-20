// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a stored remediation artifact (a patch, an Official export, a
 * toolchain spec patch) from the plugin-sources bucket for the download
 * routes. A key whose object is gone reads as null (the routes answer 404,
 * not 500); any other storage error propagates.
 */

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '@pipeline-builder/api-core/s3';

import { pluginSourcesBucket } from '../plugin-sources.js';

/** Reads a stored remediation artifact's text (null = not stored). */
export type ArtifactReader = (key: string) => Promise<string | null>;

const isMissingObject = (err: unknown): boolean => {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'NoSuchKey' || name === 'NotFound';
};

export const readRemediationArtifact: ArtifactReader = async (key) => {
  try {
    const out = await s3Client().send(new GetObjectCommand({ Bucket: pluginSourcesBucket(), Key: key }));
    return out.Body ? await out.Body.transformToString('utf-8') : null;
  } catch (err) {
    if (isMissingObject(err)) return null;
    throw err;
  }
};
