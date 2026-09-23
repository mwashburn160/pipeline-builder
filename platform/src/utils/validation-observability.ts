// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Request schemas for the observability surface: alert destinations, alert
 * rules and dashboards. Split out of `utils/validation.ts` so the size caps
 * these schemas read from `config.observability` are declared next to the only
 * three controllers that use them.
 */

import { z } from 'zod';
import { config } from '../config/index.js';

// Observability: alert destinations and dashboards

const {
  alertDestinationMaxLabel,
  dashboardMaxName,
  dashboardMaxDescription,
  dashboardMaxPanelTitle,
  dashboardMaxPanels,
} = config.observability;

const alertChannelSchema = z.enum(['slack', 'webhook', 'in-app', 'email'], { message: 'must be slack, webhook, in-app, or email' });
const alertSeveritySchema = z.enum(['warning', 'critical'], { message: 'must be warning or critical' });
/** `enabled` is honoured only when it is a real boolean; anything else leaves it unset. */
const optionalBoolean = z.unknown().optional().transform((v) => (typeof v === 'boolean' ? v : undefined));

/** POST /observability/alert-destinations. The target's per-channel rules and
 *  the webhook SSRF check need the channel (and, on update, the stored row), so
 *  the controller applies them after this shape check. */
export const createAlertDestinationSchema = z.object({
  channel: alertChannelSchema,
  label: z.string().min(1, 'is required').max(alertDestinationMaxLabel),
  target: z.unknown().optional().transform((v) => (typeof v === 'string' ? v : '')),
  minSeverity: alertSeveritySchema.optional(),
  enabled: optionalBoolean,
});

/** PUT /observability/alert-destinations/:id — every field optional; an empty
 *  target means "keep the stored one". */
export const updateAlertDestinationSchema = z.object({
  channel: alertChannelSchema.optional(),
  label: z.string().min(1).max(alertDestinationMaxLabel).optional(),
  target: z.string().optional(),
  minSeverity: alertSeveritySchema.optional(),
  enabled: optionalBoolean,
});

type DashboardLayout = Record<string, { x: number; y: number; w: number; h: number }>;

/** One panel's SHAPE. Whether its catalog key exists and is available to the
 *  caller is decided in the controller (it depends on who is asking). */
const dashboardPanelSchema = z.object({
  queryKey: z.string().min(1).max(100),
  title: z.string().min(1).max(dashboardMaxPanelTitle),
  vizKind: z.string().min(1).max(30).optional(),
  span: z.number().min(1).max(12).optional(),
  groupBy: z.unknown().optional().transform((v) => (typeof v === 'string' ? v : null)),
  format: z.unknown().optional().transform((v) => (typeof v === 'string' ? v : null)),
  position: z.unknown().optional().transform((v) => (typeof v === 'number' ? v : undefined)),
});

const dashboardFields = {
  description: z.string().min(1).max(dashboardMaxDescription).nullish(),
  visibility: z.enum(['private', 'org', 'public'], { message: 'must be one of: private, org, public' }).optional(),
  /** Grid positions by panel; a non-object is ignored rather than refused. */
  layoutJson: z.unknown().optional().transform((v) => (v && typeof v === 'object' ? v as DashboardLayout : undefined)),
  panels: z.array(dashboardPanelSchema).max(dashboardMaxPanels, `exceeds the ${dashboardMaxPanels}-panel cap`).optional(),
};

/** POST /dashboards. */
export const createDashboardSchema = z.object({
  name: z.string().min(1, 'is required').max(dashboardMaxName),
  ...dashboardFields,
});

/** PUT /dashboards/:id — a partial update; `panels`, when present, replaces the set. */
export const updateDashboardSchema = z.object({
  name: z.string().min(1).max(dashboardMaxName).optional(),
  ...dashboardFields,
});

// Alert rules

const alertRuleFields = {
  forDuration: z.string().optional(),
  severity: z.enum(['warning', 'critical'], { message: 'must be warning or critical' }).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
};

/** POST /observability/alert-rules. The PromQL itself is checked (and scoped
 *  to the org) by the alert-rule service after this shape check. */
export const createAlertRuleSchema = z.object({
  name: z.string({ message: 'is required' }),
  expr: z.string({ message: 'is required' }),
  summary: z.string({ message: 'is required' }),
  ...alertRuleFields,
});

/** PUT /observability/alert-rules/:id — any subset of the same fields. */
export const updateAlertRuleSchema = z.object({
  name: z.string().optional(),
  expr: z.string().optional(),
  summary: z.string().optional(),
  ...alertRuleFields,
});
