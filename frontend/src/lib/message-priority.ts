// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Message priority — which is also a support case's severity — keyed by its
 * wire id (api-core `MESSAGE_PRIORITIES`): the label, and for the raised levels
 * the badge tone and icon. `normal` carries no badge: it is the absence of a
 * priority, and badging every message would make the raised ones invisible.
 */

import { MESSAGE_PRIORITIES } from '@pipeline-builder/api-core/wire-vocabulary';
import { AlertOctagon, AlertTriangle, type LucideIcon } from 'lucide-react';
import type { MessagePriority } from '@/types';

export const MESSAGE_PRIORITY_META: Record<MessagePriority, {
  label: string;
  badge: { className: string; icon: LucideIcon } | null;
}> = {
  normal: { label: 'Normal', badge: null },
  high: { label: 'High', badge: { className: 'bg-warning-bg text-warning', icon: AlertTriangle } },
  urgent: { label: 'Urgent', badge: { className: 'bg-danger-bg text-danger', icon: AlertOctagon } },
};

/** Every priority, lowest first. */
export const MESSAGE_PRIORITY_IDS: readonly MessagePriority[] = MESSAGE_PRIORITIES;

export function isMessagePriority(value: string): value is MessagePriority {
  return Object.hasOwn(MESSAGE_PRIORITY_META, value);
}
