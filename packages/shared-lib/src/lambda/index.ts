import { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda';
import { PluginConfig } from '../plugin-config';

export let handler = async (event: CloudFormationCustomResourceEvent): Promise<CloudFormationCustomResourceResponse> => {
  let config: PluginConfig = {
    pluginName: 'name',
    pluginType: 'CodeBuildStep',
    version: '1.0.0',
    commands: []
  }
  let resp: CloudFormationCustomResourceResponse = {
    Status: 'FAILED',
    PhysicalResourceId: '57a087f7-d8b3-403a-b447-5890761e5073',
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Reason: 'Plugin config lookup failed.'
  };
  try {
    resp = {
      ...resp,
      Status: 'SUCCESS',
      Reason: 'Plugin config lookup successful.',
      Data: { PluginConfig: JSON.stringify(config) }
    }
  } catch (error) {
    if (error instanceof Error) {
      resp = {
        ...resp,
        Reason: error.message
      }
    }
  }
  return resp;
};