import { join } from 'path';
import { createLogger } from '@mwashburn160/api-core';
import { PluginFilter, Plugin } from '@mwashburn160/pipeline-data';
import { CustomResource, Token, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import type { PluginOptions } from './step-types';
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
}

/**
 * CDK Construct responsible for looking up plugin configurations from an external platform
 * using AWS CloudFormation Custom Resources backed by a Lambda function.
 *
 * This construct creates:
 * - A Lambda function (plugin-lookup-handler) that fetches plugin configs
 * - A CloudWatch Log Group for the Lambda
 * - A Custom Resource Provider that invokes the Lambda
 *
 * @see handlers/plugin-lookup-handler.ts for the Lambda implementation
 */
export class PluginLookup extends Construct {
  private readonly _uniqueId: UniqueId;
  private readonly _provider: Provider;
  private readonly _platformUrl: string;
  private readonly _runtime: Runtime;

  constructor(scope: Construct, id: string, props: PluginLookupProps) {
    super(scope, id);

    if (!props.organization || !props.project) {
      throw new Error('Both organization and project are required.');
    }

    this._uniqueId = props.uniqueId;
    this._platformUrl = props.platformUrl;
    this._runtime = props.runtime ?? Runtime.NODEJS_20_X;

    const onEventHandler = this.createLambdaFunction();

    const logGroup = new LogGroup(this, this._uniqueId.generate('log:group'), {
      logGroupName: `/aws/lambda/${this._uniqueId.generate('plugin:lookup')}`,
      retention: RetentionDays.ONE_WEEK,
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
      return this.default();
    }

    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      return JSON.parse(decoded) as Plugin;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      log.warn(`Failed to parse plugin data: ${errorMsg}`);
      return this.default();
    }
  }

  /**
   * Creates the Lambda function that serves as the event handler for the custom resource provider
   */
  private createLambdaFunction(): NodejsFunction {
    const entrypoint = join(__dirname, '/../handlers/plugin-lookup-handler.js');
    const handlerId = this._uniqueId.generate('onevent:handler');

    const fn = new NodejsFunction(this, handlerId, {
      runtime: this._runtime,
      timeout: Duration.seconds(30),
      memorySize: 256,
      architecture: Architecture.ARM_64,
      entry: entrypoint,
      environment: {
        PLATFORM_BASE_URL: this._platformUrl,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
      },
    });

    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      }),
    );

    return fn;
  }

  /**
   * Normalizes plugin input (string name or PluginOptions) into consistent PluginOptions format
   */
  private normalize(plugin: string | PluginOptions): PluginOptions {
    if (typeof plugin === 'string') {
      return {
        name: plugin,
        filter: { name: plugin, isActive: true, isDefault: true, accessModifier: 'public' },
        alias: `${plugin}-alias`,
      };
    }

    return {
      name: plugin.name,
      alias: plugin.alias ?? `${plugin.name}-alias`,
      filter: plugin.filter ?? { name: plugin.name, isDefault: true },
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
   * Returns fallback/default plugin configuration used when:
   * - value is unresolved during synthesis
   * - custom resource response cannot be parsed
   */
  private default(): Plugin {
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
      primaryOutputDirectory: 'dist',
      env: {},
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
