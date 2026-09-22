// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Password rules shared by the API schema (`utils/validation.ts`
 * `passwordSchema`) and the User model's save hook, so a value that passes API
 * validation never trips the hook (and vice versa). The minimum length is
 * `config.auth.passwordMinLength` (tunable per environment), raised further by
 * an org's own policy (helpers/password-policy.ts).
 */

/** Hard ceiling on any password (and on an org's minimum). bcrypt reads only
 *  72 bytes, and an unbounded value is a hashing DoS. Not configurable. */
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_RULES: ReadonlyArray<{ test: RegExp; message: string }> = [
  { test: /[A-Z]/, message: 'Password must contain at least one uppercase letter' },
  { test: /[a-z]/, message: 'Password must contain at least one lowercase letter' },
  { test: /[0-9]/, message: 'Password must contain at least one digit' },
];
