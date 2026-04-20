// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { join } from 'path';
import { createLogger } from '@pipeline-builder/api-core';
import { PluginFilter, Plugin } from '@pipeline-builder/pipeline-data';
import { CustomResource, Token, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import type { PluginOptions } from './step-types';
import { Config, CoreConstants } from '../config/app-config';
import { UniqueId } from '../core/id-generator';

const log = createLogger('Lookup');

interface InputProps {
  readonly baseURL: string;
  readonly pluginFilter: PluginFilter;
}

/**
 * Configuration for PluginLookup construct
 */
export interface PluginLookupProps {
  readonly organization: string;
  readonly project: string;
  readonly platformUrl: string;
  readonly uniqueId: UniqueId;
  /** Organization ID for resolving per-org secrets from Secrets Manager */
  readonly orgId?: string;
  readonly runtime?: Runtime;
  /** Lambda timeout (default: 30s) */
  readonly timeout?: Duration;
  /** Lambda memory in MB (default: 512) */
  readonly memorySize?: number;
  /** Log retention (default: ONE_WEEK) */
  readonly logRetention?: RetentionDays;
  /** Reserved concurrent executions for the lookup Lambda (default: 30) */
  readonly reservedConcurrentExecutions?: number;
}

/**
 * CDK Construct responsible for looking up plugin configurations from an external platform
 * using AWS CloudFormation Custom Resources backed by a Lambda function.
 *
 * This construct creates:
 * - A Lambda function (plugin-lookup-handler) that fetches plugin configs
 * - A CloudWatch Log Group for the Lambda
 * - A Custom Resource Provider that invokes the Lambda
 * - An IAM policy granting the Lambda access to the credentials secret
 *
 * ## Prerequisites
 *
 * Before deploying, store a JWT token in Secrets Manager:
 * ```sh
 * pipeline-manager store-token --days 30 --region <region>
 * ```
 *
 * The Lambda resolves the secret by name at runtime:
 * `{SECRETS_PATH_PREFIX}/{orgId}/platform`
 *
 * @see handlers/plugin-lookup-handler.ts for the Lambda implementation
 */
export class PluginLookup extends Construct {
  private readonly _uniqueId: UniqueId;
  private readonly _provider: Provider;
  private readonly _platformUrl: string;
  private readonly _runtime: Runtime;
  private readonly _timeout: Duration;
  private readonly _memorySize: number;
  private readonly _reservedConcurrentExecutions?: number;
  private readonly _orgId?: string;

  constructor(scope: Construct, id: string, props: PluginLookupProps) {
    super(scope, id);

    if (!props.organization || !props.project) {
      throw new Error('Both organization and project are required.');
    }

    this._uniqueId = props.uniqueId;
    this._platformUrl = props.platformUrl;
    this._orgId = props.orgId;
    this._runtime = props.runtime ?? Runtime.NODEJS_24_X;
    this._timeout = props.timeout ?? Duration.seconds(30);
    this._memorySize = props.memorySize ?? Config.get('aws').lambda.memorySize;
    this._reservedConcurrentExecutions = props.reservedConcurrentExecutions;

    const onEventHandler = this.createLambdaFunction();

    const logGroup = new LogGroup(this, this._uniqueId.generate('log:group'), {
      logGroupName: `/aws/lambda/${this._uniqueId.generate('plugin:lookup').replace(/:/g, '-')}`,
      retention: props.logRetention ?? RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this._provider = new Provider(this, this._uniqueId.generate('resource:provider'), {
      onEventHandler,
      logGroup,
    });

    log.debug(`PluginLookup initialized for ${props.organization}/${props.project}`);
  }

  /**
   * Looks up and resolves plugin configuration using either a simple name or full PluginOptions object
   * During synthesis, if the value is unresolved (token), returns fallback plugin
   * During deployment, attempts to parse the actual value returned by the custom resource
   * @param plugin - Plugin name (string) or complete PluginOptions configuration
   * @returns Resolved Plugin object or fallback default configuration
   */
  public plugin(plugin: string | PluginOptions): Plugin {
    const props = this.normalize(plugin);
    const custom = this.createCustomResource(props);
    const encoded = custom.getAttString('ResultValue');

    if (Token.isUnresolved(encoded)) {
      log.debug(`Plugin "${props.name}" value is unresolved (token) during synthesis — using fallback. The actual plugin will be resolved at deployment time.`);
      return this.fallback();
    }

    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      const data = JSON.parse(decoded);

      if (!data || typeof data !== 'object' || !data.name || !Array.isArray(data.commands)) {
        throw new Error('Invalid plugin response: missing required fields (name, commands)');
      }

      return data as Plugin;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to parse plugin "${props.name}" data: ${errorMsg}`);
    }
  }

  /**
   * Creates the Lambda function that serves as the event handler for the custom resource provider.
   *
   * JWT token is stored in a pre-existing Secrets Manager secret at
   * `{SECRETS_PATH_PREFIX}/{orgId}/platform`. The Lambda resolves the
   * secret by name at runtime using `CoreConstants.SECRETS_PATH_PREFIX`.
   *
   * Create the secret before deploying with:
   *   pipeline-manager store-token --days 30 --region <region>
   */
  private createLambdaFunction(): NodejsFunction {
    if (!this._orgId) {
      throw new Error('orgId is required for PluginLookup — needed to resolve the per-org platform secret');
    }
    const secretName = CoreConstants.secretPath(this._orgId, 'platform');

    const fn = new NodejsFunction(this, this._uniqueId.generate('onevent:handler'), {
      runtime: this._runtime,
      timeout: this._timeout,
      memorySize: this._memorySize,
      architecture: Architecture.ARM_64,
      entry: join(__dirname, '/../handlers/plugin-lookup-handler.js'),
      depsLockFilePath: join(__dirname, '/../handlers/pnpm-lock.yaml'),
      reservedConcurrentExecutions: this._reservedConcurrentExecutions,
      environment: {
        PLATFORM_SECRET_NAME: secretName,
        // Allow self-signed certs when platform uses HTTPS without a CA-signed certificate
        ...(process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' && {
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        }),
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2022',
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Grant the Lambda permission to read the per-org platform secret.
    // The wildcard suffix handles the 6-char random ID that Secrets Manager appends.
    fn.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:*:*:secret:${secretName}-*`],
    }));

    return fn;
  }

  /**
   * Build the default plugin filter.
   * Access control (orgId scoping, public/private visibility) is handled by
   * the platform's access control query builder based on the JWT's organizationId.
   */
  private defaultFilter(name: string): PluginFilter {
    return {
      name,
      isActive: true,
      isDefault: true,
    };
  }

  private normalize(plugin: string | PluginOptions): PluginOptions {
    if (typeof plugin === 'string') {
      return {
        name: plugin,
        filter: this.defaultFilter(plugin),
        alias: `${plugin}-alias`,
      };
    }

    return {
      name: plugin.name,
      alias: plugin.alias ?? `${plugin.name}-alias`,
      filter: plugin.filter ?? this.defaultFilter(plugin.name),
      metadata: plugin.metadata,
    };
  }

  /**
   * Creates a CustomResource instance that triggers plugin lookup during deployment
   */
  private createCustomResource(props: PluginOptions): CustomResource {
    const resourceId = this._uniqueId.generate(props.alias || props.name);

    return new CustomResource(this, resourceId, {
      serviceToken: this._provider.serviceToken,
      resourceType: 'Custom::PluginLookup',
      properties: {
        baseURL: this._platformUrl,
        pluginFilter: props.filter,
      } as InputProps,
    });
  }

  /** Base plugin shape with no-op defaults for fields CDK doesn't use. */
  private static basePlugin(): Plugin {
    const now = new Date();
    return {
      id: '00000000-0000-0000-0000-000000000000',
      orgId: 'system',
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
      imageTag: '',
      dockerfile: null,
      buildType: 'metadata_only',
      accessModifier: 'public',
      isDefault: false,
      isActive: true,
      deletedAt: null,
      deletedBy: null,
    };
  }

  /** Fallback for unresolved plugin lookup tokens during synthesis. */
  private fallback(): Plugin {
    return {
      ...PluginLookup.basePlugin(),
      commands: ['echo "FALLBACK: Plugin lookup unresolved — will be resolved at deployment time"'],
    };
  }

  /**
   * Synth plugin with pipeline-manager commands.
   * Used when RESOLVED_SYNTH_PLUGIN is not set (default/CLI) — CDK needs real
   * commands at synthesis time, but the custom resource resolves at deploy time.
   */
  public fallbackSynth(): Plugin {
    return {
      ...PluginLookup.basePlugin(),
      name: 'cdk-synth',
      primaryOutputDirectory: 'cdk.out',
      commands: [
        'pipeline-manager synth --id ${PIPELINE_ID} --store-tokens --quiet --no-notices --no-verify-ssl',
      ],
    };
  }
}
