// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ApiClient } from './api-client';
import { printSuccess, printWarning } from './output-utils';

/**
 * Pre-resolve the synth plugin from the platform API so CDK has real commands
 * at synthesis time. CloudFormation custom resource lookup only resolves at
 * deploy time, which is too late for the synth step.
 *
 * @param client - Authenticated API client
 * @param props - Pipeline props (synth.plugin must contain name)
 * @returns The props with resolvedSynthPlugin embedded, or unchanged if resolution fails
 */
export async function resolveSynthPlugin(
  client: ApiClient,
  props: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const synth = props.synth as Record<string, unknown> | undefined;
  const synthPlugin = synth?.plugin as Record<string, unknown> | undefined;

  if (!synthPlugin?.name) return props;

  try {
    const pluginName = synthPlugin.name as string;
    const filter = synthPlugin.filter as Record<string, unknown> | undefined;
    const lookupResponse = await client.post<Record<string, unknown>>(
      '/api/plugins/lookup',
      { filter: { name: pluginName, ...filter } },
    );
    const pluginData = (lookupResponse as Record<string, unknown>)?.data ?? lookupResponse;

    if (pluginData && typeof pluginData === 'object' && (pluginData as Record<string, unknown>).name) {
      printSuccess(`Synth plugin "${pluginName}" pre-resolved`);
      return { ...props, resolvedSynthPlugin: pluginData };
    }
  } catch {
    printWarning('Could not pre-resolve synth plugin — will use fallback during synthesis');
  }

  return props;
}
