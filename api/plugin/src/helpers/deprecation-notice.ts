// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE place a plugin version's deprecation is announced.
 *
 * Every path that deprecates a version — `POST /plugins/:id/deprecate` and a
 * `PUT /plugins/:id` that moves `lifecycle` to `deprecated` — calls
 * {@link onPluginDeprecated} and nothing else.
 *
 * The notice is event **N14** ("Listing deprecated or unmaintained"), sent
 * to the org approvers (`plugin_installs:manage`, falling back to the root org
 * and then the owners) of every org whose pipelines use the version
 * (`pluginService.findOrgsUsingVersion`). Recipients travel as per-org RULES
 * the platform relay resolves and mails individually, so the publisher never
 * learns who uses the plugin and no org sees another org's name. The version
 * is also visible at lookup (the `warnings` array), printed by synth and
 * hidden from AI selection.
 *
 * A version PUBLISHED to the ecosystem carries the deprecation over to its
 * listing versions, whose installing orgs get their own N14.
 */

import { createLogger, errorMessage, type EcosystemRecipientSpec } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';

import { deprecateListedFromSource } from '../services/ecosystem/version-deprecation.js';
import { enqueueEcosystemNotification } from '../services/ecosystem-notifications.js';
import { pluginService } from '../services/plugin-service.js';

const logger = createLogger('plugin-deprecation');

/** Recipient rules per relay request (the relay caps a request at 50). */
export const DEPRECATION_RECIPIENT_CHUNK = 50;

/** The deprecated version, as the notice needs it. */
export interface DeprecatedPlugin {
  id: string;
  orgId: string;
  name: string;
  version: string;
  isDefault: boolean;
  visibility: string | null;
  buildType?: string | null;
  deprecationMessage?: string | null;
}

/** The N14 notice body. Carries only the plugin — nothing about other orgs. */
export function renderDeprecationNotice(plugin: DeprecatedPlugin): { subject: string; text: string } {
  const ref = `${plugin.name}@${plugin.version}`;
  const reason = plugin.deprecationMessage?.trim();
  return {
    subject: `Plugin ${ref} is deprecated`,
    text: [
      `Plugin ${ref}, used by pipelines in your organization, has been deprecated.`,
      ...(reason ? [`Reason: ${reason}`] : []),
      'It keeps resolving for now, but synth prints a warning and it is no longer offered for new pipelines. '
        + 'Move your pipelines to a supported version.',
    ].join('\n\n'),
  };
}

/**
 * Announce that `plugin` was deprecated by `actor`. Never rejects: a failure is
 * logged and counted, and the deprecation itself stands. Callers fire and
 * forget (`void onPluginDeprecated(...)`).
 */
export async function onPluginDeprecated(plugin: DeprecatedPlugin, actor: string): Promise<void> {
  incCounter('plugin_deprecations_total');
  logger.info('Plugin version deprecated', {
    event: 'plugin.version.deprecated',
    pluginId: plugin.id,
    orgId: plugin.orgId,
    pluginName: plugin.name,
    pluginVersion: plugin.version,
    actorId: actor,
    hasMessage: Boolean(plugin.deprecationMessage),
  });

  // Listed copies of this version (never throws).
  await deprecateListedFromSource(plugin, actor);

  try {
    const orgs = await pluginService.findOrgsUsingVersion(plugin);
    if (orgs.length === 0) return;
    const content = renderDeprecationNotice(plugin);
    for (let i = 0; i < orgs.length; i += DEPRECATION_RECIPIENT_CHUNK) {
      const recipients: EcosystemRecipientSpec[] = orgs.slice(i, i + DEPRECATION_RECIPIENT_CHUNK).map((orgId) => ({
        kind: 'org_permission', orgId, permission: 'plugin_installs:manage', inheritFromRoot: true,
      }));
      await enqueueEcosystemNotification('N14', recipients, content);
    }
    incCounter('plugin_deprecation_notices_total');
    logger.info('Plugin deprecation notice sent', { pluginId: plugin.id, orgCount: orgs.length });
  } catch (err) {
    incCounter('plugin_deprecation_notice_failures_total');
    logger.error('Plugin deprecation notice failed', { pluginId: plugin.id, error: errorMessage(err) });
  }
}
