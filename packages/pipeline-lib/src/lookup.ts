import { CustomResource, Token } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { Constants } from './constants';
import { UniqueId } from './unique-id';
import { PluginConfig } from './plugin-config';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';

/**
 * A construct that creates a custom resource to fetch PluginConfig data using a Lambda-backed provider.
 */
export class Lookup extends Construct {
    private readonly _uniqueId: UniqueId;
    private readonly _provider: Provider;
    private _config: PluginConfig;

    /**
     * @param scope - The parent construct.
     * @param id - The construct ID.
     * @param organization - The organization name.
     * @param project - The project name.
     */
    constructor(scope: Construct, id: string, organization: string, project: string) {
        super(scope, id);
        if (!organization || !project) {
            throw new Error('organization and project are required');
        }

        this._config = {
            pluginName: 'no_pluginname',
            pluginType: 'CodeBuildStep',
            version: '1.0.0',
            commands: [],
        };
        this._uniqueId = new UniqueId(organization, project);
        const onEventHandler = new NodejsFunction(this, this._uniqueId.generate('onevent-handler'), {
            runtime: Constants.NODEJS_VERSION,
            timeout: Constants.DEFAULT_TIMEOUT,
            memorySize: Constants.DEFAULT_MEMORY_SIZE,
            architecture: Constants.DEFAULT_ARCHITECTURE,
            entry: Constants.LAMBDA_ENTRY_PATH || `${__dirname}/custom-resource/index.ts`,
        });

        onEventHandler.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [`arn:aws:logs:${this.stack.region}:${this.stack.account}:log-group:/aws/lambda/${onEventHandler.functionName}:*`],
        }));

        this._provider = new Provider(this, this._uniqueId.generate('resource-provider'), {
            onEventHandler,
            logRetention: Constants.DEFAULT_LOG_RETENTION,
        });
    }

    /**
     * Fetches a PluginConfig for the given pluginName using a custom resource.
     * @param pluginName - The name of the plugin to fetch configuration for.
     * @returns The PluginConfig object.
     * @throws Error if the configuration cannot be fetched or parsed.
     */
    config(pluginName: string): PluginConfig {
        if (!pluginName) {
            throw new Error('pluginName is required');
        }
        try {
            const custom = new CustomResource(this, this._uniqueId.generate(pluginName), {
                serviceTimeout: Constants.DEFAULT_TIMEOUT,
                serviceToken: this._provider.serviceToken,
                resourceType: 'Custom::PluginConfig',
                properties: { pluginName },
            });
            const pluginConfig = custom.getAttString('PluginConfig');
            if (!Token.isUnresolved(pluginConfig)) {
                this._config = JSON.parse(pluginConfig);
                if (!this._config.commands?.length) {
                    throw new Error(`PluginConfig for ${pluginName} has no commands`);
                }
            } else {
                throw new Error(`PluginConfig for ${pluginName} is unresolved during synthesis`);
            }
        } catch (error) {
            throw new Error(`Failed to fetch PluginConfig for ${pluginName}: ${error}`);
        }
        return this._config;
    }
}
