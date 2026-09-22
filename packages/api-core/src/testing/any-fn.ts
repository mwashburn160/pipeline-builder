// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The loosest function type, for `jest.fn<AnyFn>()`.
 *
 * WHY: an untyped `jest.fn()` is `Mock<UnknownFunction>` under `@jest/globals`,
 * whose `mockResolvedValue` / `mockReturnValue` take `never` and whose
 * `mock.calls` are `unknown[]` — so every `jest.fn().mockResolvedValue(x)` in a
 * suite is a type error the moment the test tree is type-checked. A suite that
 * cares about the signature should type the mock with the real function type
 * (`jest.fn<typeof realFn>()`); a suite that is only stubbing a collaborator
 * uses this.
 *
 * USAGE:
 *   import type { AnyFn } from '@pipeline-builder/api-core/testing';
 *   const send = jest.fn<AnyFn>().mockResolvedValue({ ok: true });
 */
export type AnyFn = (...args: any[]) => any;
