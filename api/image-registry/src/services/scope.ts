// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A single registry access scope: one resource (`<type>:<name>`) plus the
 * actions requested/granted on it. This is the common shape shared across the
 * token service (parsed challenge scopes + issued JWT `access` claims) and the
 * registry client (management-token scoping) — one definition instead of three
 * parallel copies.
 *
 * `type` is kept as a plain `string` (Docker Distribution defines `repository`
 * and `registry`, but the field is an open extension point).
 */
export interface RegistryScope {
  type: string;
  name: string;
  actions: string[];
}
