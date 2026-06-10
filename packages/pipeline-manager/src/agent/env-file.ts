// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Create a target's `.env` from its `.env.example` for targets that use one
 * (local / minikube). `setup.sh` aborts if `.env` is missing, and the example
 * carries working dev defaults EXCEPT secrets marked `CHANGE_ME...` — so we copy
 * it and fill those with fresh URL-safe random values (safe both as HMAC keys
 * and inside connection-string passwords). Optional integration placeholders
 * (e.g. OAuth client ids) are left as-is for the operator to fill in later.
 */

import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';

/** True when `<cwd>/<dir>` ships a `.env.example` but has no `.env` yet. */
export function envFileMissing(cwd: string, dir: string): boolean {
  return existsSync(path.join(cwd, dir, '.env.example')) && !existsSync(path.join(cwd, dir, '.env'));
}

/** URL-safe random secret (no `+/=`, ~43 chars) — fine for HMAC keys + DB passwords. */
function secret(): string {
  return randomBytes(32).toString('base64').replace(/[+/=]/g, '');
}

/**
 * Copy `<dir>/.env.example` → `<dir>/.env`, replacing each `CHANGE_ME...`
 * placeholder with a freshly generated secret. Returns the number generated.
 */
export function createEnvFile(cwd: string, dir: string): number {
  const example = readFileSync(path.join(cwd, dir, '.env.example'), 'utf8');
  let generated = 0;
  const filled = example.replace(/CHANGE_ME[A-Za-z0-9_]*/g, () => {
    generated += 1;
    return secret();
  });
  writeFileSync(path.join(cwd, dir, '.env'), filled);
  return generated;
}
