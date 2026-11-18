// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared authentication for the server-to-server endpoints Alertmanager calls.
 *
 * These are the only non-JWT auth gates in platform: Alertmanager is a service,
 * not a person, so it presents a per-instance shared secret
 * (`ALERT_WEBHOOK_INSTANCES`) as a bearer token alongside an
 * `X-Alertmanager-Instance` header naming which entry to compare against.
 *
 * This lives here, extracted from the relay handler, because a SECOND endpoint
 * now needs exactly this check (PVC auto-expansion). Two copies of a
 * constant-time token comparison is precisely the kind of duplication that
 * drifts — one gets a fix the other does not — and this one guards an endpoint
 * that mutates cluster storage.
 */

import { safeEqual } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import { config } from '../config/index.js';

export interface AlertmanagerInstance {
  id: string;
  token: string;
  previousToken?: string;
  allowedOrgIds?: string[];
}

export type AlertmanagerAuthResult =
  | { ok: true; instance: AlertmanagerInstance }
  | { ok: false; status: 401 | 503; message: string; reason: string };

/**
 * Validate the caller as a configured Alertmanager instance.
 *
 * Returns the failure as data rather than throwing so each caller chooses its
 * own response shape and logging, without any of them being able to skip the
 * check by forgetting a try/catch.
 */
export function authenticateAlertmanager(req: Request): AlertmanagerAuthResult {
  const provided = req.headers.authorization?.replace(/^Bearer\s+/, '') || '';
  const instanceHeader = (req.headers['x-alertmanager-instance'] || '').toString();

  // Unconfigured is 503, not 401: nothing is wrong with the CALLER, the relay
  // simply is not set up, and a 401 would send an operator hunting for a bad
  // token that does not exist.
  if (config.alertWebhook.instances.length === 0) {
    return { ok: false, status: 503, message: 'Alert relay not configured', reason: 'no-instances' };
  }
  if (!instanceHeader) {
    return { ok: false, status: 401, message: 'X-Alertmanager-Instance header required', reason: 'no-instance-header' };
  }
  const instance = config.alertWebhook.instances.find((i) => i.id === instanceHeader);
  if (!instance) {
    return { ok: false, status: 401, message: 'Unauthorized', reason: 'unknown-instance' };
  }
  // Both compared without short-circuiting, so response timing cannot reveal
  // WHICH token matched during a rotation.
  const matchesCurrent = safeEqual(provided, instance.token);
  const matchesPrevious = instance.previousToken ? safeEqual(provided, instance.previousToken) : false;
  if (!matchesCurrent && !matchesPrevious) {
    return { ok: false, status: 401, message: 'Unauthorized', reason: 'bad-token' };
  }
  return { ok: true, instance };
}
