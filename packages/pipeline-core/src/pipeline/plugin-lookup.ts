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
import { PluginOptions } from './pipeline-types';
import { Config } from '../config/app-config';
import { UniqueId } from '../core/id-generator';

const log = createLogger('Lookup');

export interface InputProps {
  readonly baseURL: string;
  readonly pluginFilter: PluginFilter;
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

  /**
   * @param scope - Scope in which this construct is defined
   * @param id - Construct identifier
   * @param organization - Organization identifier used for namespacing and lookup
   * @param project - Project identifier used for namespacing and lookup
   */
  constructor(scope: Construct, id: string, organization: string, project: string) {
    super(scope, id);

    log.debug(`Initializing construct for org: ${organization}, project: ${project}`);

    if (!organization || !project) {
      log.error('Missing required parameters: organization or project');
      throw new Error('Both organization and project are required.');
    }

    this._uniqueId = new UniqueId(organization, project);
    const onEventHandler = this.createLambdaFunction();

    log.debug('Creating log group');
    const logGroup = new LogGroup(this, this._uniqueId.generate('log-group'), {
      logGroupName: `/aws/lambda/${this._uniqueId.generate('plugin-lookup')}`,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    log.debug('Creating custom resource provider');
    this._provider = new Provider(this, this._uniqueId.generate('resource-provider'), {
      onEventHandler,
      logGroup,
    });

    log.debug('Construct initialization complete');
  }

  /**
   * Looks up and resolves plugin configuration using either a simple name or full PluginOptions object
   * During synthesis, if the value is unresolved (token), returns fallback plugin
   * During deployment, attempts to parse the actual value returned by the custom resource
   * @param plugin - Plugin name (string) or complete PluginOptions configuration
   * @returns Resolved Plugin object or fallback default configuration
   */
  public plugin(plugin: string | PluginOptions): Plugin {
    const pluginName = typeof plugin === 'string' ? plugin : plugin.name;
    log.debug(`Looking up plugin: ${pluginName}`);

    const props = this.normalize(plugin);
    const custom = this.createCustomResource(props);
    const encoded = custom.getAttString('ResultValue');

    if (Token.isUnresolved(encoded)) {
      log.debug('Token unresolved during synthesis - returning default plugin');
      return this.default();
    }

    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded) as Plugin;
      log.debug(`Successfully parsed plugin: ${parsed.name} (ID: ${parsed.id})`);
      return parsed;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      log.warn(`Failed to parse plugin data: ${errorMsg}`);
      return this.default();
    }
  }

  /**
   * Creates the Lambda function that serves as the event handler for the custom resource provider
   * @returns Configured NodejsFunction ready to handle Create/Update/Delete events
   */
  private createLambdaFunction(): NodejsFunction {
    const entrypoint = join(__dirname, '/../handlers/plugin-lookup-handler.js');
    const handlerId = this._uniqueId.generate('onevent-handler');
    const config = Config.get();

    log.debug(`Creating onEvent Lambda: ${handlerId}`);

    const fn = new NodejsFunction(this, handlerId, {
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      architecture: Architecture.ARM_64,
      entry: entrypoint,
      environment: {
        PLATFORM_BASE_URL: config.server.platformUrl,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
      },
    });

    log.debug('Adding CloudWatch Logs permissions to Lambda');

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
   * @param plugin - Input to normalize (plugin name or full props)
   * @returns Normalized PluginOptions object ready for custom resource
   */
  private normalize(plugin: string | PluginOptions): PluginOptions {
    log.debug('Normalizing plugin input');

    if (typeof plugin === 'string') {
      log.debug(`Created from string: ${plugin}`);
      return {
        name: plugin,
        filter: { name: plugin, isActive: true, isDefault: true, accessModifier: 'public' },
        alias: `${plugin}-alias`,
      };
    }

    log.debug(`Created from props: ${plugin.name}`);
    return {
      name: plugin.name,
      alias: plugin.alias ?? `${plugin.name}-alias`,
      filter: plugin.filter ?? { name: plugin.name, isDefault: true },
      metadata: plugin.metadata,
    };
  }

  /**
   * Creates a CustomResource instance that triggers plugin lookup during deployment
   * @param props - Normalized properties containing base URL and filter
   * @returns Configured CustomResource
   */
  private createCustomResource(props: PluginOptions): CustomResource {
    const resourceId = this._uniqueId.generate(props.alias || props.name);
    log.debug(`Creating CustomResource: ${resourceId}`);

    const config = Config.get();
    const baseURL = config.server.platformUrl;

    const custom = new CustomResource(this, resourceId, {
      serviceToken: this._provider.serviceToken,
      resourceType: 'Custom::PluginLookup',
      properties: {
        baseURL,
        pluginFilter: props.filter,
      } as InputProps,
    });

    log.debug('CustomResource created successfully');
    return custom;
  }

  /**
   * Returns fallback/default plugin configuration used when:
   * - value is unresolved during synthesis
   * - custom resource response cannot be parsed
   * @returns Safe default Plugin configuration
   */
  private default(): Plugin {
    log.debug('Returning fallback default plugin');
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