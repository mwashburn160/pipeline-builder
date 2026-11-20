// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared authentication for the server-to-server endpoints Alertmanager calls.
 *
 * These are the only non-JWT auth gates in ops-center: Alertmanager is a service,
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

/**
 * Every way the check refuses, keyed by the reason callers branch and log on.
 * Unconfigured is 503, not 401: nothing is wrong with the CALLER, the relay
 * simply is not set up, and a 401 would send an operator hunting for a bad
 * token that does not exist.
 */
export const ALERTMANAGER_AUTH_FAILURES = {
  'no-instances': { status: 503, message: 'Alert relay not configured' },
  'no-instance-header': { status: 401, message: 'X-Alertmanager-Instance header required' },
  'unknown-instance': { status: 401, message: 'Unauthorized' },
  'bad-token': { status: 401, message: 'Unauthorized' },
} as const satisfies Record<string, { status: 401 | 503; message: string }>;

/** Why {@link authenticateAlertmanager} refused. */
export type AlertmanagerAuthFailureReason = keyof typeof ALERTMANAGER_AUTH_FAILURES;

export type AlertmanagerAuthResult =
  | { ok: true; instance: AlertmanagerInstance }
  | { ok: false; status: 401 | 503; message: string; reason: AlertmanagerAuthFailureReason };

function refuse(reason: AlertmanagerAuthFailureReason): AlertmanagerAuthResult {
  return { ok: false, ...ALERTMANAGER_AUTH_FAILURES[reason], reason };
}

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

  if (config.alertWebhook.instances.length === 0) return refuse('no-instances');
  if (!instanceHeader) return refuse('no-instance-header');
  const instance = config.alertWebhook.instances.find((i) => i.id === instanceHeader);
  if (!instance) return refuse('unknown-instance');
  // Both compared without short-circuiting, so response timing cannot reveal
  // WHICH token matched during a rotation.
  const matchesCurrent = safeEqual(provided, instance.token);
  const matchesPrevious = instance.previousToken ? safeEqual(provided, instance.previousToken) : false;
  if (!matchesCurrent && !matchesPrevious) return refuse('bad-token');
  return { ok: true, instance };
}
