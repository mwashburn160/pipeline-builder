// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, MANAGED_TOOLCHAIN, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { PluginFilter } from '@pipeline-builder/pipeline-data';
import type { PluginOptions } from './step-types.js';
import { platformTlsVerify } from '../core/platform-tls.js';
import { pluginArtifactAlias, pluginLookupFilter } from '../core/plugin-contract.js';
import type { ResolvedPlugin } from '../core/plugin-lookup-envelope.js';
import { PLACEHOLDER_PLUGIN_ID } from '../core/step-manifest.js';

const log = createLogger('plugin-lookup');

/**
 * Configuration for {@link PluginLookup}.
 */
export interface PluginLookupProps {
  /**
   * Plugins pre-resolved by `pipeline-manager pipeline synth` from the platform API.
   * Keyed by `pluginArtifactAlias` (the explicit alias, else
   * `[<publisher>-]<name>-alias` — the key normalize() computes). This is
   * what makes the name, version, commands, env, etc. available at synth time
   * so the resulting CFN template ships with the real values baked in.
   */
  readonly resolvedPlugins?: Record<string, ResolvedPlugin>;
}

/**
 * Hands each step its pre-resolved plugin record, and refuses (fails the
 * synth) a plugin that was not pre-resolved.
 *
 * Plain data, not a construct: every plugin is resolved by the CLI before the
 * CDK app runs, so nothing here deploys anything — no Lambda, no custom
 * resource.
 */
export class PluginLookup {
  private readonly _resolvedPlugins?: Record<string, ResolvedPlugin>;

  constructor(props: PluginLookupProps = {}) {
    this._resolvedPlugins = props.resolvedPlugins;
  }

  /**
   * The plugin record for a step: the one `pipeline-manager` pre-resolved
   * (`resolvedPlugins`). Throws for a plugin that was not pre-resolved — the
   * synth fails rather than build a step that cannot run its plugin.
   * @param plugin - Plugin name (string) or complete PluginOptions configuration
   * @param stepKey - The step's label (`pluginStepLabel`: `synth` or
   *   `<stage>/<alias ?? name>`), named in the error.
   */
  public plugin(plugin: string | PluginOptions, stepKey?: string): ResolvedPlugin {
    const props = this.normalize(plugin);

    // Pre-resolved by `pipeline-manager pipeline synth` from the platform API:
    // the plugin's name, version, commands, env, etc. are known at synth time,
    // so the resulting CFN template ships with the real CodeBuild image baked in.
    // normalize() always sets the alias (pluginArtifactAlias).
    const cacheKey = props.alias!;
    const preResolved = this._resolvedPlugins?.[cacheKey] as (ResolvedPlugin & { publisher?: string | null }) | undefined;
    // The map is keyed by ALIAS, so check it actually holds THIS plugin. Two
    // steps sharing an alias across different plugins would otherwise get the
    // first one's record back — the second step silently running the wrong
    // image and commands. The CLI refuses such a pipeline too; this covers any other
    // caller that supplies `resolvedPlugins`.
    // Compare against the name the lookup actually TARGETED: an explicit
    // `filter.name` overrides the ref's `name` by design, and that is not a
    // collision.
    const targetName = (props.filter as { name?: string } | undefined)?.name ?? props.name;
    if (preResolved && preResolved.name !== targetName) {
      throw new Error(
        `Plugin alias "${cacheKey}" resolves to "${preResolved.name}", not "${targetName}". `
        + 'Each alias must name exactly one plugin.',
      );
    }
    // A qualified reference must have resolved to THAT publisher's listing
    // (an unqualified one may resolve to the org's own plugin or the Official
    // listing).
    if (preResolved && props.publisher && preResolved.publisher !== props.publisher) {
      throw new Error(
        `Plugin alias "${cacheKey}" resolves to ${preResolved.publisher ? `${preResolved.publisher}/` : 'your organization\'s '}${preResolved.name}, `
        + `not ${props.publisher}/${targetName}. Each alias must name exactly one plugin.`,
      );
    }
    if (preResolved) {
      log.debug(`Plugin "${props.name}" pre-resolved (alias=${cacheKey})`);
      return preResolved;
    }

    // A step without its record has no image or commands to run, and a step
    // that can't run its plugin must fail at synth — never ship as a placeholder.
    throw new Error(
      `Plugin "${props.publisher ? `${props.publisher}/` : ''}${props.name}"${stepKey ? ` (step ${stepKey})` : ''} was not resolved before synth. `
      + 'Synthesize through `pipeline-manager pipeline synth/deploy --id`, which resolves every plugin from the platform and fails with the reason when one does not resolve; '
      + 'a CDK app constructing PipelineBuilder directly, or a `--local-spec` deploy, must supply the record in `resolvedPlugins`.',
    );
  }

  /**
   * Build the default plugin filter.
   * Access control (orgId scoping, public/private visibility) is handled by
   * the platform's access control query builder based on the JWT's organizationId.
   */
  private normalize(plugin: string | PluginOptions): PluginOptions {
    const ref: PluginOptions = typeof plugin === 'string' ? { name: plugin } : plugin;
    return {
      name: ref.name,
      ...(ref.publisher ? { publisher: ref.publisher } : {}),
      // The resolver cache key: the explicit alias, else `[<publisher>-]<name>-alias`.
      alias: pluginArtifactAlias(ref),
      // The same filter the CLI pre-resolver and the pipeline service's
      // contract check send (`pluginLookupFilter`): name + publisher, then
      // the reference's own filter, else the default version.
      filter: pluginLookupFilter({ name: ref.name, publisher: ref.publisher, filter: ref.filter as Record<string, unknown> | undefined }) as PluginFilter,
      metadata: ref.metadata,
    };
  }

  /** Base plugin shape with no-op defaults for fields CDK doesn't use. */
  private static basePlugin(): ResolvedPlugin {
    const now = new Date();
    return {
      id: PLACEHOLDER_PLUGIN_ID,
      orgId: SYSTEM_ORG_ID,
      createdBy: 'system',
      createdAt: now,
      updatedBy: 'system',
      updatedAt: now,
      name: 'fallback',
      description: null,
      keywords: [],
      category: 'unknown',
      version: '1.0.0',
      metadata: {},
      pluginType: 'CodeBuildStep',
      computeType: 'SMALL',
      timeout: null,
      failureBehavior: 'fail',
      secrets: [],
      primaryOutputDirectory: 'cdk.out',
      env: {},
      buildArgs: {},
      installCommands: [],
      commands: [],
      buildType: 'metadata_only',
      imageDigest: null,
      imageSource: null,
      ownerId: null,
      ownerType: null,
      lifecycle: 'production',
      criticality: null,
      labels: {},
      links: [],
      visibility: 'public',
      isDefault: false,
      isActive: true,
      deletedAt: null,
      deletedBy: null,
      purgeAfter: null,
      quotaResetAt: null,
      summary: null,
      displayName: null,
      documentationUrl: null,
      metadataSources: {},
      requiredMetadata: [],
      requiredVars: [],
      metadataTypes: {},
      varsTypes: {},
      smokeTest: null,
      networkEgress: [],
      license: null,
      homepageUrl: null,
      sourceUrl: null,
      vulnCritical: null,
      vulnHigh: null,
      vulnMedium: null,
      vulnLow: null,
      vulnCriticalFixable: null,
      vulnHighFixable: null,
      scannedAt: null,
      scanFlaggedAt: null,
      scanFlag: null,
      runAsRoot: null,
      breaking: false,
      frozenAt: null,
      yankedAt: null,
      yankReason: null,
      deprecatedAt: null,
      deprecationMessage: null,
    };
  }

  /**
   * Synth plugin with pipeline-manager commands: the synth step of a
   * PipelineBuilder constructed WITHOUT a pre-resolved synth plugin (a CDK app
   * building it directly — `pipeline-manager pipeline synth/deploy` always
   * pre-resolves it, or fails the synth). Runs on the
   * resolved toolchain release's `pipeline-bootstrap` image (the pipeline's
   * `resolvedBootstrap`, pinned by digest) and self-bootstraps the real synth
   * via `pipeline-manager pipeline synth --id ${PIPELINE_ID}`.
   *
   * No `installCommands`: the bootstrap image has the release's pinned
   * `pipeline-manager` baked in — that is what the image is for.
   *
   * TLS is VERIFIED by default: this lookup returns the image digests every
   * step is pinned to, so an unverified connection would let a MITM choose what
   * runs. A private-CA platform is trusted through `PLATFORM_CA_BUNDLE`, which
   * the synth propagates into every CodeBuild step. Only an explicit
   * `PLATFORM_TLS_VERIFY=false` at synth time (a dev platform on a self-signed
   * certificate) adds `--no-verify-ssl` — and the CLI refuses that in
   * production. See core/platform-tls.ts.
   */
  public bootstrap(): ResolvedPlugin {
    const tlsFlag = platformTlsVerify() ? '' : ' --no-verify-ssl';
    return {
      ...PluginLookup.basePlugin(),
      name: MANAGED_TOOLCHAIN.synth,
      primaryOutputDirectory: 'cdk.out',
      commands: [
        `pipeline-manager pipeline synth --id \${PIPELINE_ID} --store-tokens --quiet --no-notices${tlsFlag}`,
      ],
    };
  }
}
