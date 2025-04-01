import { CodePipeline, CodePipelineSource, CodeBuildStep, ShellStep, IFileSetProducer } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { Lookup } from './lookup';
import { UniqueId } from './unique-id';
import { InputProps } from './props';
import { Bucket, IBucket } from 'aws-cdk-lib/aws-s3';
import { PluginConfig } from './plugin-config';
import { Constants } from './constants';
import { Tags } from 'aws-cdk-lib';

export interface PipelineBuilderProps {
  readonly project: string;
  readonly organization: string;
  readonly synthPluginName?: string;
  readonly input: InputProps;
}

export class PipelineBuilder extends Construct {
  private _uniqueId: UniqueId;
  private _pipeline: CodePipeline;
  private _lookup: Lookup;

  constructor(scope: Construct, id: string, props: PipelineBuilderProps) {
    super(scope, id);
    let input: CodePipelineSource
    this._uniqueId = new UniqueId(props.organization, props.project);
    this._lookup = new Lookup(this, this._uniqueId.generate('custom-resource'), props.organization, props.project);

    switch (props.input.inputType) {
      case 'S3': {
        let bucket: IBucket = Bucket.fromBucketName(this, this._uniqueId.generate('s3-bucket'), props.input.s3Options?.bucketName || 'no_bucketname')
        input = CodePipelineSource.s3(bucket, props.input.s3Options?.objectKey || '/', {
          role: props.input.s3Options?.role,
          trigger: props.input.s3Options?.trigger,
          actionName: props.input.s3Options?.actionName
        })
        break
      }
      case 'GitHub': {
        input = CodePipelineSource.gitHub(props.input.gitHubOptions?.repository || 'no_repository', props.input.gitHubOptions?.branch || 'main', {
          trigger: props.input.gitHubOptions?.trigger,
          actionName: props.input.gitHubOptions?.actionName,
          authentication: props.input.gitHubOptions?.authentication
        })
        break
      }
      default: {
        input = CodePipelineSource.connection(props.input.connectionOptions?.repository || 'no_repository', props.input.connectionOptions?.branch || 'main', {
          actionName: props.input.connectionOptions?.actionName,
          triggerOnPush: props.input.connectionOptions?.triggerOnPush,
          connectionArn: props.input.connectionOptions?.connectionArn || 'arn:aws:codestar-connections:us-east-1:123456789012:connection/12345678-abcd-12ab-34cdef5678gh',
          codeBuildCloneOutput: props.input.connectionOptions?.codeBuildCloneOutput
        })
        break
      }
    }
    let config = this._lookup.config(props.synthPluginName || Constants.DEFAULT_SYNTH_PLUGIN_NAME)
    this._pipeline = new CodePipeline(this, this._uniqueId.generate('pipeline'), {
      synth: this.shellStep(this._uniqueId.generate('pipeline::synth'), config, input)
    });
    Tags.of(this._pipeline).add("project", props.project);
    Tags.of(this._pipeline).add("organization", props.organization);
  }

  private shellStep(id: string, config: PluginConfig, input?: IFileSetProducer): ShellStep {
    let shellStep: ShellStep
    switch (config.pluginType) {
      case 'ShellStep': {
        shellStep = new ShellStep(id, {
          input: input,
          commands: config.commands
        })
        break
      }
      default: {
        shellStep = new CodeBuildStep(id, {
          input: input,
          commands: config.commands
        })
        break
      }
    }
    return shellStep
  }
}