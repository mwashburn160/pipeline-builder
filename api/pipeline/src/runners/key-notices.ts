// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org notices for runner signing-key events, through the existing system
 * notification channel (the org inbox, which fans out to email and webhooks).
 * One notice per org: the key's org and every team that inherits it. Key ids
 * only — never key material.
 */

import { createLogger, errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { RunnerDeps } from './deps.js';

const logger = createLogger('runner-key-notices');

export type KeyNoticeEvent =
  | { kind: 'generate'; kid: string; auto: boolean; forTeam?: boolean }
  | { kind: 'rotate'; kid: string; activatesAt: Date }
  | { kind: 'promote'; kid: string; previousKid: string | null }
  | { kind: 'revoke'; kid: string | null; newActiveKid: string | null; bySystem: boolean }
  | { kind: 'mode'; from: string; to: string; switchAt: Date }
  | { kind: 'age'; kid: string; ageDays: number; followup: boolean };

const short = (kid: string | null) => (kid ? `…${kid.slice(-6)}` : 'none');

type EventOf<K extends KeyNoticeEvent['kind']> = Extract<KeyNoticeEvent, { kind: K }>;

/** One entry per event kind: its priority and its text (key ids only). */
const KEY_NOTICES: { [K in KeyNoticeEvent['kind']]: { priority: 'high' | 'normal'; text: (e: EventOf<K>) => { subject: string; content: string } } } = {
  generate: {
    priority: 'normal',
    text: (e) => ({
      subject: 'Runner signing key created',
      content: `${e.forTeam ? "A runner signing key was created when a team's first runner was registered" : e.auto ? 'A runner signing key was created when your first runner was registered' : 'A runner signing key was generated'} (key ${short(e.kid)}). Your runners verify run requests with it.`,
    }),
  },
  rotate: {
    priority: 'normal',
    text: (e) => ({
      subject: 'Runner signing key rotation started',
      content: `A new runner signing key (${short(e.kid)}) is published and starts signing at ${e.activatesAt.toISOString()}. The old key stays valid for 1 hour after that.`,
    }),
  },
  promote: {
    priority: 'normal',
    text: (e) => ({
      subject: 'Runner signing key now active',
      content: `Run requests are now signed with key ${short(e.kid)}. The previous key (${short(e.previousKid)}) stays published for 1 hour.`,
    }),
  },
  revoke: {
    priority: 'high',
    text: (e) => ({
      subject: 'Runner signing key revoked',
      content: `${e.bySystem ? 'Your platform operator revoked' : 'An administrator revoked'} runner signing key ${short(e.kid)}. Requests already signed with it are refused and retried with the new key (${short(e.newActiveKid)}).`,
    }),
  },
  mode: {
    priority: 'normal',
    text: (e) => ({
      subject: 'Runner signing key mode changed',
      content: `The runner signing key mode changed from ${e.from} to ${e.to}. Signing switches at ${e.switchAt.toISOString()}; the old keys stay published for 1 hour after that.`,
    }),
  },
  age: {
    priority: 'normal',
    text: (e) => ({
      subject: e.followup ? 'Runner signing key is overdue for rotation' : 'Runner signing key is due for rotation',
      content: `Runner signing key ${short(e.kid)} is ${e.ageDays} days old. Consider rotating it from Settings → Organization → Pipeline runners.`,
    }),
  },
};

/** The catalog entry of an event (one lookup keeps the kind and its text paired). */
function noticeOf<K extends KeyNoticeEvent['kind']>(e: EventOf<K>) {
  const entry = KEY_NOTICES[e.kind as K];
  return { priority: entry.priority, ...entry.text(e) };
}

/** Send one event's notice to each org (deduplicated). Never throws. */
export async function sendKeyNotice(deps: RunnerDeps, orgIds: readonly string[], event: KeyNoticeEvent): Promise<void> {
  const { subject, content, priority } = noticeOf(event);
  for (const recipientOrgId of [...new Set(orgIds.map((o) => o.toLowerCase()))]) {
    try {
      await deps.notify({ recipientOrgId, subject, content, priority });
    } catch (err) {
      logger.warn('Runner key notice not sent', { recipientOrgId, kind: event.kind, error: errorMessage(err) });
    }
  }
}

/** Tell the platform operator (the system org) that an org's key can't be decrypted. Never throws. */
export async function sendUnreadableKeyNotice(deps: RunnerDeps, orgId: string): Promise<void> {
  try {
    await deps.notify({
      recipientOrgId: SYSTEM_ORG_ID,
      subject: 'Runner signing key unreadable',
      content: `The runner signing key of organization ${orgId} cannot be decrypted (wrong SECRET_ENCRYPTION_KEY or a rotated KMS key). Runs through that organization's runners are paused. Restore the previous key or re-encrypt (reencrypt-runner-keys).`,
      priority: 'high',
    });
  } catch (err) {
    logger.warn('Unreadable-key notice not sent', { orgId, error: errorMessage(err) });
  }
}
