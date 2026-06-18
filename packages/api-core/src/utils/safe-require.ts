// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';

/**
 * Build a CommonJS `require` for synchronously loading OPTIONAL installed
 * packages from ESM code (e.g. prom-client, @opentelemetry/api, ioredis behind
 * a try/catch).
 *
 * Pass `import.meta.url`. When this ESM source is bundled to CJS — as the CDK
 * Lambda handlers are — esbuild replaces `import.meta` with `{}`, so the value
 * is `undefined` and a bare `createRequire(import.meta.url)` throws at module
 * load ("The argument 'filename' must be a file URL… Received undefined"). We
 * fall back to the process entry path so there's always a valid resolution base
 * (the base only needs to exist within the project for node_modules lookup).
 */
export function safeCreateRequire(metaUrl: string | undefined): NodeRequire {
  return createRequire(metaUrl || process.argv[1] || `${process.cwd()}/index.js`);
}
