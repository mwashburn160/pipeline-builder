// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Print what superseded system plugin versions cost, as JSON, and change
 * nothing. Run from a plugin-service container (it needs the service's database
 * and image-registry settings):
 *
 *   node lib/scripts/measure-superseded.js
 *
 * See services/retention/measure.ts for what each figure means.
 */

import { measureSuperseded } from '../services/retention/measure.js';

try {
  process.stdout.write(`${JSON.stringify(await measureSuperseded(), null, 2)}\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`measure-superseded failed: ${(err as Error).message}\n`);
  process.exit(1);
}
