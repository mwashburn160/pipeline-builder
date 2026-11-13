// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A template's props without a toolchain release pin: pipeline templates never
 * carry `toolchain` (docs/plans/bootstrap-image-versioning.md D12) — a template
 * is a starting point, and a pin is a per-pipeline decision with its own
 * eligibility check. Stripped on save, ignored on instantiate.
 */
export function withoutToolchainPin<T extends Record<string, unknown> | null | undefined>(props: T): T {
  if (!props || typeof props !== 'object' || !('toolchain' in props)) return props;
  const { toolchain: _toolchain, ...rest } = props as Record<string, unknown>;
  return rest as T;
}
