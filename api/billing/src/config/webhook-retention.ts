// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How long a webhook's durable `done` dedupe marker lives (models/webhook-dedupe).
 * A standalone module so the marker TTL and the SNS replay window that depends on
 * it (helpers/sns-freshness) share one source of truth without one importing the
 * other's model layer.
 */
export const WEBHOOK_DONE_TTL_SECONDS = 30 * 24 * 60 * 60;
