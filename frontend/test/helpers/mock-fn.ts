// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The signature of an untyped test double: `jest.fn<AnyFn>()`.
 *
 * Tests import their globals from `@jest/globals`, whose bare `jest.fn()` is
 * `Mock<(...args: unknown[]) => unknown>` — so `.mockResolvedValue(x)` expects
 * `never` and every stubbed return is a type error. Under `@types/jest` (which
 * the frontend suites were written against) the same call was `Mock<any>`.
 * `AnyFn` states that explicitly, one name for every double that stands in for
 * something whose exact type the test does not care about.
 *
 * Prefer a real signature (`jest.fn<typeof api.getThing>()`) when the test DOES
 * care — it then type-checks the stub against the thing it replaces.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately untyped; see above
export type AnyFn = (...args: any[]) => any;
