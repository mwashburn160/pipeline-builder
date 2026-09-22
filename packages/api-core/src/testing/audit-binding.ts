// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bind a service identity for `recordAudit` in a suite that runs the REAL
 * api-core (no `jest.unstable_mockModule('@pipeline-builder/api-core', …)`).
 *
 * `recordAudit` throws "audit not initialised" until `wireServiceSecurity` has
 * bound the service at boot; a route/unit suite never runs the boot module, so it
 * binds here instead. The returned spy receives each recorded event exactly as
 * the call site passed it (no service-name argument), so assertions read the
 * same as against `apiCoreMock({ recordAudit: spy })`.
 *
 * Suites that DO mock api-core use `apiCoreMock({ recordAudit: spy })` (the
 * default mock's `recordAudit` is an inert `jest.fn()`).
 */

import { jest } from '@jest/globals';
import { bindAuditService, unbindAuditService } from '../services/remote-audit-client.js';

/** The recorded-event spy {@link bindTestAuditService} returns. */
export type AuditSpy = ReturnType<typeof jest.fn<(event: unknown) => void>>;

/**
 * Bind `serviceName` with a spy client (nothing is delivered, no Redis spool).
 * Call AFTER importing a boot module that runs `wireServiceSecurity`, since that
 * rebinds to the real client.
 */
export function bindTestAuditService(serviceName = 'test-service', spy: AuditSpy = jest.fn<(event: unknown) => void>()): AuditSpy {
  bindAuditService(serviceName, { record: (event) => spy(event), close: () => undefined });
  return spy;
}

/** Return the process to the unbound state (`recordAudit` throws again). */
export function unbindTestAuditService(): void {
  unbindAuditService();
}
