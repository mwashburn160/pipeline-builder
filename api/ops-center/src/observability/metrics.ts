// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Business-metric helpers for the moved code. In platform these wrote to
 * platform's own registry; here they are api-server's, whose registry is the
 * one this service's `/metrics` serves. Metric names are unchanged by the move
 * (only the scrape job / `service` label is now `ops-center`).
 */
export { incCounter, observe, setGauge } from '@pipeline-builder/api-server';
