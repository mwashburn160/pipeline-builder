// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Point the CLI's home directory at a throwaway temp dir for one suite.
 *
 * Setting `process.env.HOME` is NOT enough: jest hands the test a copy of
 * `process.env`, and `os.homedir()` reads the real process environment, so the
 * credential store and config loader went on resolving to the developer's own
 * `~/.pipeline-manager` — suites that sign in or out were reading and WRITING
 * the real `credentials.json`. The store and loader resolve their paths at
 * import time, so call this BEFORE importing them (a static import of this
 * module, or a call above the suite's `await import(...)`s).
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

export function useTempHome(prefix: string): string {
  const home = mkdtempSync(join(os.tmpdir(), prefix));
  jest.spyOn(os, 'homedir').mockReturnValue(home);
  process.env.HOME = home;
  return home;
}
