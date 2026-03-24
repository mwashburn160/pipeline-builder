import { join } from 'path';
import { createLogger } from '@mwashburn160/api-core';
import { PluginFilter, Plugin } from '@mwashburn160/pipeline-data';
import { CustomResource, Token, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import type { PluginOptions } from './step-types';
import { CoreConstants } from '../config/app-config';
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
  readonly runtime?: Runtime;
  /** Lambda timeout (default: 30s) */
  readonly timeout?: Duration;
  /** Lambda memory in MB (default: 256) */
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
 * Before deploying, store the service credentials in Secrets Manager:
 * ```sh
 * pipeline-manager store-credentials --email <email> --password <password> --region <region>
 * ```
 *
 * The Lambda resolves the secret by name at runtime:
 * `{SECRETS_PATH_PREFIX}/system/credentials` (default: `pipeline-builder/system/credentials`)
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

  constructor(scope: Construct, id: string, props: PluginLookupProps) {
    super(scope, id);

    if (!props.organization || !props.project) {
      throw new Error('Both organization and project are required.');
    }

    this._uniqueId = props.uniqueId;
    this._platformUrl = props.platformUrl;
    this._runtime = props.runtime ?? Runtime.NODEJS_24_X;
    this._timeout = props.timeout ?? Duration.seconds(30);
    this._memorySize = props.memorySize ?? 256;
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
      totalTimeout: Duration.minutes(5),
      queryInterval: Duration.seconds(10),
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
   * Service credentials are stored in a pre-existing Secrets Manager secret at
   * `{SECRETS_PATH_PREFIX}/system/credentials`. The Lambda resolves the
   * secret by name at runtime using the same `CoreConstants.SECRETS_PATH_PREFIX`.
   *
   * Create the secret before deploying with:
   *   pipeline-manager store-credentials --email <email> --password <password>
   */
  private createLambdaFunction(): NodejsFunction {
    const lockfile = join(__dirname, '/../handlers/pnpm-lock.yaml');
    const entrypoint = join(__dirname, '/../handlers/plugin-lookup-handler.js');
    const handlerId = this._uniqueId.generate('onevent:handler');

    const fn = new NodejsFunction(this, handlerId, {
      runtime: this._runtime,
      timeout: this._timeout,
      memorySize: this._memorySize,
      architecture: Architecture.ARM_64,
      entry: entrypoint,
      depsLockFilePath: lockfile,
      reservedConcurrentExecutions: this._reservedConcurrentExecutions,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
      },
    });

    // Grant the Lambda permission to read the credentials secret by name.
    // The secret name follows the standard format: {prefix}/system/credentials
    // The wildcard suffix handles the 6-char random ID that Secrets Manager appends.
    const secretName = `${CoreConstants.SECRETS_PATH_PREFIX}/system/credentials`;
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

  /**
   * Returns fallback plugin configuration used only when the plugin value is
   * an unresolved CDK token during synthesis. This is expected — the actual
   * plugin will be resolved at deployment time via the Custom Resource.
   *
   * IMPORTANT: This fallback should never appear in a deployed stack. If it
   * does, it indicates the Custom Resource failed to resolve the plugin.
   * The fallback uses empty commands so CodeBuild will fail visibly.
   */
  private fallback(): Plugin {
    return {
      id: '00000000-0000-0000-0000-000000000000',
      orgId: 'system',
      createdBy: 'system',
      createdAt: new Date(),
      updatedBy: 'system',
      updatedAt: new Date(),
      name: 'no_pluginname',
      description: null,
      keywords: [],
      version: '1.0.0',
      metadata: {},
      pluginType: 'CodeBuildStep',
      computeType: 'SMALL',
      timeout: null,
      failureBehavior: 'fail',
      secrets: [],
      primaryOutputDirectory: null,
      env: {},
      buildArgs: {},
      installCommands: [],
      commands: [],
      imageTag: 'no_image_tag',
      dockerfile: null,
      accessModifier: 'public',
      isDefault: false,
      isActive: true,
      deletedAt: null,
      deletedBy: null,
    };
  }
}
