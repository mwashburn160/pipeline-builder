import { CustomResource } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { Constants } from './constants';
import { UniqueId } from './unique-id';
import { PluginConfig } from './plugin-config';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';

export class Lookup extends Construct {
  private _uniqueId: UniqueId;
  private _provider: Provider;
  private _config: PluginConfig

  constructor(scope: Construct, id: string, organization: string, project: string) {
    super(scope, id);
    this._config = {
      pluginName: 'no_pluginname',
      pluginType: 'CodeBuildStep',
      version: '1.0.0',
      commands: []
    }
    this._uniqueId = new UniqueId(organization, project);
    let onEventHandler = new NodejsFunction(this, this._uniqueId.generate('onevent-handler'), {
      runtime: Constants.NODEJS_VERSION,
      timeout: Constants.DEFAULT_TIMEOUT,
      memorySize: Constants.DEFAULT_MEMORY_SIZE,
      architecture: Constants.DEFAULT_ARCHITECTURE,
      entry: `${__dirname}/lambda/index.ts`,
    });

    onEventHandler.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*']
    }))
    this._provider = new Provider(this, this._uniqueId.generate('resource-provider'), {
      onEventHandler: onEventHandler,
      logRetention: Constants.DEFAULT_LOG_RETENTION
    });
  }

  config(pluginName: string): PluginConfig {
    try {
      let custom = new CustomResource(this, this._uniqueId.generate(pluginName), {
        serviceTimeout: Constants.DEFAULT_TIMEOUT,
        serviceToken: this._provider.serviceToken,
        resourceType: "Custom::PluginConfig",
        properties: {
          pluginName: pluginName,
        },
      });
      this._config = JSON.parse(custom.getAttString('PluginConfig'))
    } catch (error) {
      console.log(error)
    }
    return this._config
  }
}