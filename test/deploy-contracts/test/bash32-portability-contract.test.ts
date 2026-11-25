// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * deploy/bin scripts run on the stock macOS bash (3.2) — deploy/bin/common.sh
 * "BASH 3.2 / macOS PORTABILITY". `mapfile` / `readarray` and associative
 * arrays are bash 4+: on 3.2 the script dies at that line (validate-configs.sh
 * did, after every other check, so its nginx -t stage never ran on a Mac).
 *
 * A script that genuinely needs bash 4 must say so up front with a
 * BASH_VERSINFO guard and a clear error, as report-plugin-go-stdlib.sh does.
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';
import { REPO_ROOT, read } from '../src/index.js';

const BIN = 'deploy/bin';
const scripts = readdirSync(join(REPO_ROOT, BIN)).filter((f) => f.endsWith('.sh')).sort();

describe('deploy/bin scripts run on bash 3.2', () => {
  it.each(scripts.map((s) => [s]))('%s uses no bash-4-only builtin without a version guard', (script) => {
    const text = read(`${BIN}/${script}`);
    const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const bash4 = code.match(/(^|[\s;(|&])(mapfile|readarray|declare\s+-A|local\s+-A)\b/gm) ?? [];
    if (bash4.length === 0) return;
    expect({ script, guarded: /BASH_VERSINFO\[0\]\}?"?\s*-ge\s*4/.test(code) }).toEqual({ script, guarded: true });
  });
});
