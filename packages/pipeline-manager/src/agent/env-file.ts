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
 * placeholder with a generated secret. Returns the count of DISTINCT secrets.
 *
 * Crucially, the bare `CHANGE_ME` placeholder marks a service *password* that is
 * referenced from several vars which MUST agree — e.g. POSTGRES_PASSWORD ==
 * DB_PASSWORD, and the mongo password is repeated across MONGO_INITDB_ROOT_PASSWORD,
 * the inline `mongodb://…:CHANGE_ME@…` URIs, and ME_CONFIG_*. So every bare
 * `CHANGE_ME` gets the SAME value (a per-`.env` shared password) — otherwise the
 * services can't authenticate and the stack fails to start. The suffixed form
 * (`CHANGE_ME_generate_with_openssl_rand_base64_32` → JWT_SECRET, REFRESH_TOKEN_SECRET)
 * marks an independent crypto secret, so each of those gets a unique value.
 */
export function createEnvFile(cwd: string, dir: string): number {
  const example = readFileSync(path.join(cwd, dir, '.env.example'), 'utf8');
  const sharedPassword = secret();
  const values = new Set<string>();
  const filled = example.replace(/CHANGE_ME[A-Za-z0-9_]*/g, (match) => {
    const value = match === 'CHANGE_ME' ? sharedPassword : secret();
    values.add(value);
    return value;
  });
  writeFileSync(path.join(cwd, dir, '.env'), filled);
  return values.size;
}
