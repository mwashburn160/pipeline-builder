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
 * Its own dependency-free module: `utils/validation.ts` sources password rules
 * from `models/user.ts`, so importing the rule from there would drag mongoose in
 * behind anything that only wants to check an address.
 */

/** Matches `local@domain`, with or without a dotted TLD. See the module note. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

