// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '@pipeline-builder/api-core';

/**
 * A log-safe rendering of an unknown error. drizzle-orm's `DrizzleQueryError`
 * embeds the failed SQL statement AND the bound parameter values (real data) in
 * its `.message` (`Failed query: <sql>\nparams: <values>`). Never put that in a
 * response, a log line or an audit record — collapse it to the error name.
 * Other errors are rendered by `errorMessage`.
 */
export function safeErrorForLog(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('Failed query:')) {
    return `${error.name || 'DrizzleQueryError'}: database query failed`;
  }
  return errorMessage(error);
}
