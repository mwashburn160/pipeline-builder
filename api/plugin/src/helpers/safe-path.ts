// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import path from 'path';

import { ValidationError } from '@pipeline-builder/api-core';

/**
 * Validate a path from config/spec does not contain traversal or absolute references.
 *
 * Shared by plugin-spec.ts (config paths) and the build strategies (Dockerfile
 * resolution) — lives in its own module so the strategies can import it without a
 * cycle back through plugin-spec.ts.
 */
export function validateSafePath(label: string, rawPath: string): string {
  const normalized = path.normalize(rawPath);
  if (
    normalized.includes('\0') ||
    normalized.includes('..') ||
    path.isAbsolute(normalized) ||
    normalized.includes(path.sep + path.sep) ||
    normalized.startsWith(path.sep)
  ) {
    throw new ValidationError(`Invalid ${label} path: must not contain path traversal or be absolute`);
  }
  return normalized;
}
