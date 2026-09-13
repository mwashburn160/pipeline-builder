// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The platform's single email-ADDRESS rule. (Sending lives in `utils/email.ts`.)
 *
 * Deliberately RELAXED: it requires `local@domain` but NOT a dotted TLD, so
 * `user@internal` is valid alongside `user@example.com`. Internal/intranet
 * addresses are a first-class case here — the shipped default super-admin is
 * `admin@internal` (`BOOTSTRAP_SUPERADMIN_EMAILS`). This is a typo catcher, not
 * an RFC 5322 parser.
 *
 * Its own dependency-free module for two reasons:
 *   1. `utils/validation.ts` sources password rules from `models/user.ts`, so
 *      importing the rule from there drags mongoose in behind anything that
 *      only wants to check an address — which is why
 *      `controllers/alert-destinations.ts` grew its own copy in the first place.
 *   2. That copy additionally required a TLD, so an address the platform happily
 *      registers and invites — including its own `admin@internal` default — was
 *      rejected as an email alert destination, with no stated reason for the
 *      stricter rule.
 */

/** Matches `local@domain`, with or without a dotted TLD. See the module note. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

/** Whether `value` is an acceptable email address for this platform. */
export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}
